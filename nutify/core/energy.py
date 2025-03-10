from flask import render_template, jsonify, request
from datetime import datetime, timedelta
from .db_module import (
    get_ups_model, 
    data_lock,
    VariableConfig, 
    db, 
    UPSEvent,
    get_ups_data
)
import calendar
from sqlalchemy import func
import pytz
from . import settings
from core.logger import energy_logger as logger
import requests
from .mail import NotificationSettings
from typing import TypeVar
from core.settings import parse_time_format

# Type annotation for UPSDynamicData
UPSDynamicData = TypeVar('UPSDynamicData')

logger.info("⚡ Initializing energy")

def get_configured_timezone():
    """ Get the configured timezone from settings"""
    try:
        return pytz.timezone(settings.TIMEZONE)
    except Exception as e:
        logger.error(f"Error getting timezone from settings: {str(e)}")
        return pytz.timezone('UTC')  # Default to UTC in case of errors

def calculate_trend(current, previous):
    """Calculate the percentage trend between two values"""
    if not previous or previous == 0:
        return 0
    if current < 0.001 and previous < 0.001:  # Avoid division by very small numbers
        return 0
    trend = ((current - previous) / previous) * 100
    return min(max(round(trend, 1), -100), 1000)  # Limit the trend between -100% and 1000%

def get_nominal_power(latest_data):
    """Get UPS nominal power following the hierarchy:
    1. From API data (ups_realpower_nominal)
    2. From database
    3. From settings.conf as fallback
    """
    try:
        # 1. Check API data: if latest_data is an instance, use it; if it's the class, get the latest record
        let_inst = None
        if latest_data:
            if isinstance(latest_data, type):
                let_inst = latest_data.query.order_by(latest_data.timestamp_tz.desc()).first()
            else:
                let_inst = latest_data
            if let_inst and hasattr(let_inst, 'ups_realpower_nominal') and let_inst.ups_realpower_nominal is not None:
                return float(let_inst.ups_realpower_nominal)
        
        # 2. Check database
        UPSDynamicData = get_ups_model()
        let_inst = UPSDynamicData.query.order_by(UPSDynamicData.timestamp_tz.desc()).first()
        if let_inst and hasattr(let_inst, 'ups_realpower_nominal') and let_inst.ups_realpower_nominal is not None:
            return float(let_inst.ups_realpower_nominal)
        
        # 3. Use settings.conf as fallback
        return float(settings.UPS_REALPOWER_NOMINAL)
        
    except Exception as e:
        logger.error(f"Error getting nominal power: {str(e)}")
        return float(settings.UPS_REALPOWER_NOMINAL)

def get_energy_data(days=1, start_date=None, end_date=None):
    """
    Collects energy data using pre-calculated values
    Args:
        days: number of days (default=1)
        start_date: optional start date (datetime)
        end_date: optional end date (datetime)
    """
    try:
        UPSDynamicData = get_ups_model()
        
        # If specific dates are provided, use them
        if start_date and end_date:
            data = UPSDynamicData.query\
                .filter(
                    UPSDynamicData.timestamp_tz >= start_date,
                    UPSDynamicData.timestamp_tz <= end_date,
                    UPSDynamicData.ups_realpower_hrs.isnot(None)
                ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                
            stats = calculate_energy_stats(data, 'hrs')
            rate = get_energy_rate()
            stats['cost_distribution'] = calculate_cost_distribution(data, rate)
            return stats
            
        # Otherwise, use the existing logic with request.args
        period_type = request.args.get('type', 'day')
        from_time = request.args.get('from_time')
        to_time = request.args.get('to_time')
        
        logger.debug(f"Getting energy data - type: {period_type}, from: {from_time}, to: {to_time}")
        
        # Custom range of dates
        if period_type == 'range':
            tz = get_configured_timezone()
            start_dt = datetime.strptime(from_time, '%Y-%m-%d')
            end_dt = datetime.strptime(to_time, '%Y-%m-%d')
            start_time = tz.localize(start_dt)
            end_time = tz.localize(end_dt.replace(hour=23, minute=59, second=59))
            
            data = UPSDynamicData.query\
                .filter(
                    UPSDynamicData.timestamp_tz >= start_time,
                    UPSDynamicData.timestamp_tz <= end_time,
                    UPSDynamicData.ups_realpower_hrs.isnot(None)
                ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                
            stats = calculate_energy_stats(data, 'hrs')
            
            # Add cost distribution
            rate = get_energy_rate()
            stats['cost_distribution'] = calculate_cost_distribution(data, rate)
            
            return stats
        
        # For Real-time uses data from cache
        elif period_type == 'realtime':
            try:
                from core.db_module import ups_data_cache
                cache_data = ups_data_cache.data
                if cache_data and len(cache_data) > 0:
                    # Ensure the last data is valid
                    latest_cache = cache_data[-1]
                    if 'ups_load' in latest_cache and 'ups_realpower_nominal' in latest_cache:
                        return format_realtime_data(latest_cache)
            except Exception as e:
                logger.error(f"Error getting cache data: {str(e)}")
            # Fallback to existing method if cache fails
            latest = UPSDynamicData.query\
                .filter(UPSDynamicData.ups_realpower.isnot(None))\
                .order_by(UPSDynamicData.timestamp_tz.desc())\
                .first()
            if latest:
                return format_realtime_data(latest)
        
        # For Today with From-To
        elif period_type == 'today':
            now = datetime.now(get_configured_timezone())
            today = now.date()
            
            # Use the utility function to parse time formats
            from_time_obj = parse_time_format(from_time, datetime.strptime("00:00", '%H:%M').time())
            to_time_obj = parse_time_format(to_time, now.time())
            
            start_time = get_configured_timezone().localize(datetime.combine(today, from_time_obj))
            end_time = get_configured_timezone().localize(datetime.combine(today, to_time_obj))
            
            # Get hourly data for complete hours
            data = UPSDynamicData.query\
                .filter(
                    UPSDynamicData.timestamp_tz >= start_time,
                    UPSDynamicData.timestamp_tz <= end_time,
                    UPSDynamicData.ups_realpower_hrs.isnot(None)
                ).all()
                
            stats = calculate_energy_stats(data, 'hrs')
            
            # Add cost distribution
            rate = get_energy_rate()
            stats['cost_distribution'] = calculate_cost_distribution(data, rate)
            
            return stats
            
        # For Select Day (uses ups_realpower_hrs)
        elif period_type == 'day':
            selected_dt = datetime.strptime(from_time, '%Y-%m-%d')
            selected_date = get_configured_timezone().localize(selected_dt)
            return get_single_day_data(selected_date)
            

            
    except Exception as e:
        logger.error(f"Error getting energy data: {str(e)}")
        return default_energy_response()

def get_today_detailed_data(now, from_time, to_time):
    """Handles today's data by combining complete hours and partial minutes"""
    try:
        UPSDynamicData = get_ups_model()
        
        start_time = now.replace(
            hour=int(from_time.split(':')[0]),
            minute=int(from_time.split(':')[1]),
            second=0
        )
        end_time = now.replace(
            hour=int(to_time.split(':')[0]),
            minute=int(to_time.split(':')[1]),
            second=59
        )
        
        logger.debug(f"Getting detailed data from {start_time} to {end_time}")
        
        # Get hourly data for complete hours
        hourly_data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= start_time,
                UPSDynamicData.timestamp_tz <= end_time,
                UPSDynamicData.ups_realpower_hrs.isnot(None)
            ).all()
            
        # Get minute data for the last partial hour
        last_hour = end_time.replace(minute=0, second=0)
        minute_data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= last_hour,
                UPSDynamicData.timestamp_tz <= end_time,
                UPSDynamicData.ups_realpower.isnot(None)
            ).all()
            
        # Calculate statistics for hourly data
        hourly_stats = calculate_energy_stats(hourly_data, 'hrs')
        
        # Calculate statistics for minute data
        minute_stats = calculate_energy_stats(minute_data, 'realtime')
        
        # Combine results
        combined_stats = {
            'totalEnergy': round(hourly_stats['totalEnergy'] + minute_stats['totalEnergy'], 2),
            'totalCost': round(hourly_stats['totalCost'] + minute_stats['totalCost'], 2),
            'avgLoad': round((hourly_stats['avgLoad'] + minute_stats['avgLoad']) / 2, 1),
            'co2': round(hourly_stats['co2'] + minute_stats['co2'], 2),
            'efficiency': {
                'peak': max(hourly_stats['efficiency']['peak'], minute_stats['efficiency']['peak']),
                'average': round((hourly_stats['efficiency']['average'] + minute_stats['efficiency']['average']) / 2, 1)
            }
        }

        # Add trends
        previous_start = start_time - timedelta(days=1)
        previous_end = end_time - timedelta(days=1)
        
        previous_data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= previous_start,
                UPSDynamicData.timestamp_tz <= previous_end
            ).all()
            
        previous_stats = calculate_energy_stats(previous_data, 'hrs')
        
        combined_stats['trends'] = {
            'energy': calculate_trend(combined_stats['totalEnergy'], previous_stats['totalEnergy']),
            'cost': calculate_trend(combined_stats['totalCost'], previous_stats['totalCost']),
            'load': calculate_trend(combined_stats['avgLoad'], previous_stats['avgLoad']),
            'co2': calculate_trend(combined_stats['co2'], previous_stats['co2'])
        }
        
        return combined_stats
        
    except Exception as e:
        logger.error(f"Error in get_today_detailed_data: {str(e)}")
        return default_energy_response()

def get_today_energy_data(now):
    """Get hourly data for today"""
    start_time = now.replace(hour=0, minute=0, second=0)
    
    # Query only on hourly data
    hourly_data = UPSDynamicData.query\
        .filter(
            UPSDynamicData.timestamp_tz >= start_time,
            UPSDynamicData.timestamp_tz <= now,
            UPSDynamicData.ups_realpower_hrs.isnot(None)
        ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
        
    return calculate_energy_stats(hourly_data, 'hrs')

def get_period_energy_data(now, days):
    """Get data for periods longer than one day"""
    try:
        UPSDynamicData = get_ups_model()
        
        start_time = now - timedelta(days=days)
        
        logger.debug(f"Getting period data from {start_time} to {now}")
        
        # Query on daily data
        daily_data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= start_time,
                UPSDynamicData.timestamp_tz <= now,
                UPSDynamicData.ups_realpower_days.isnot(None)
            ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
            
        return calculate_energy_stats(daily_data, 'days')
        
    except Exception as e:
        logger.error(f"Error in get_period_energy_data: {str(e)}")
        return default_energy_response()

def calculate_energy_stats(data, period_type):
    """Calculate energy statistics based on the period"""
    try:
        logger.debug(f"Starting energy stats calculation for period_type: {period_type}")
        logger.debug(f"Number of records to process: {len(data)}")
        
        # If not realtime, calculate total energy using ups_realpower_hrs
        if period_type != 'realtime':
            # We don't divide by 1000 because ups_realpower_hrs is already in Wh
            total_energy = sum(float(row.ups_realpower_hrs or 0) for row in data)  # Wh
        else:
            # Keep the existing logic for realtime
            power = float(data.ups_realpower or 0)
            total_energy = power  # W
            
        # Calculate other statistics
        rate = float(get_energy_rate())  # Convert the Decimal to float
        # Convert to kWh only for cost calculation
        total_cost = (total_energy / 1000) * rate
        
        config = VariableConfig.query.first()
        co2_factor = float(config.co2_factor) if config else 0.4  # Convert the Decimal to float
        total_co2 = (total_energy / 1000) * co2_factor  # Convert to kWh for CO2 calculation
        
        # Calculate load statistics
        if period_type == 'realtime':
            avg_load = float(data.ups_load or 0)
            peak_load = avg_load
        else:
            loads = [float(row.ups_load or 0) for row in data if row.ups_load is not None]
            avg_load = sum(loads) / len(loads) if loads else 0
            peak_load = max(loads) if loads else 0
            
        result = {
            'totalEnergy': round(total_energy, 2),  # In Wh
            'totalCost': round(total_cost, 2),
            'avgLoad': round(avg_load, 1),
            'co2': round(total_co2, 2),
            'efficiency': {
                'peak': round(peak_load, 1),
                'average': round(avg_load, 1)
            }
        }
        
        logger.debug(f"Calculation results: {result}")
        return result
        
    except Exception as e:
        logger.error(f"Error calculating energy stats: {str(e)}")
        return default_energy_response()

def format_realtime_data(latest):
    """Format realtime data using ups_realpower directly if available."""
    try:
        if isinstance(latest, dict):
            # Directly take the ups_realpower value (no fallback calculation!)
            total_energy = float(latest['ups_realpower'])
            load = float(latest.get('ups_load', 0))
            nominal_power = float(latest.get('ups_realpower_nominal', settings.UPS_REALPOWER_NOMINAL))
        else:
            total_energy = float(latest.ups_realpower)
            load = float(latest.ups_load) if latest.ups_load is not None else 0
            nominal_power = get_nominal_power(latest)
        
        config = VariableConfig.query.first()
        co2_factor = config.co2_factor if config else 0.4
        
        total_cost = total_energy * get_energy_rate()
        total_co2 = total_energy * co2_factor
        total_saved = total_energy * get_efficiency_factor()
        
        return {
            'totalEnergy': round(total_energy, 2),
            'totalCost': round(total_cost, 2),
            'avgLoad': round(load, 1),
            'co2': round(total_co2, 2),
            'ups_realpower_nominal': nominal_power,
            'trends': {
                'energy': 0,
                'cost': 0,
                'load': 0,
                'co2': 0
            },
            'efficiency': {
                'peak': round(load, 1),
                'average': round(load, 1),
                'saved': round(total_saved, 2)
            }
        }
    except Exception as e:
        logger.error(f"Error formatting realtime data: {str(e)}")
        return default_energy_response()

def default_energy_response():
    """Default response in case of errors"""
    return {
        'totalEnergy': 0,
        'totalCost': 0,
        'avgLoad': 0,
        'co2': 0,
        'ups_realpower_nominal': float(settings.UPS_REALPOWER_NOMINAL),
        'trends': {'energy': 0, 'cost': 0, 'load': 0, 'co2': 0},
        'efficiency': {'peak': 0, 'average': 0, 'saved': 0}
    }

def calculate_efficiency(row):
    """Calculate efficiency for a single reading"""
    # Implement your logic for efficiency calculation
    # Example:
    nominal_power = float(row.ups_realpower_nominal)
    actual_power = (nominal_power * float(row.ups_load)) / 100
    # Example formula: efficiency = (actual_power / nominal_power) * 100
    return round((actual_power / nominal_power) * 100, 1) if nominal_power > 0 else 0

def get_cost_trend(type, start_time, end_time):
    """Helper function to get cost trend data"""
    try:
        UPSDynamicData = get_ups_model()
        logger.debug(f"get_cost_trend - type: {type}, start_time: {start_time}, end_time: {end_time}")
        data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= start_time,
                UPSDynamicData.timestamp_tz <= end_time
            )\
            .order_by(UPSDynamicData.timestamp_tz.asc())\
            .all()
                    
        cost_trend = []
        for row in data:
            if row.ups_realpower_nominal and row.ups_load:
                power = (float(row.ups_realpower_nominal) * float(row.ups_load)) / 100
                energy = power / 1000  # Convert to kWh
                cost = energy * get_energy_rate()
                cost_trend.append({
                    'x': row.timestamp_tz.isoformat(),
                    'y': round(cost, 4)
                })
        
        return cost_trend
    except Exception as e:
        logger.error(f"Error calculating cost trend: {str(e)}")
        return []

def register_routes(app):
    """Register all HTML and API routes for the energy section"""
    
    # Route HTML
    @app.route('/energy')
    def energy_page():
        """Render the dedicated energy cost page"""
        # Get real UPS data (DotDict object)
        ups_data = get_ups_data() or {}
        # Default data for energy statistics
        energy_stats = {
            'total_energy': 0.00,
            'total_cost': 0.00,
            'avg_load': 0.0,
            'co2': 0.00,
            'trends': {
                'energy': 0.0,
                'cost': 0.0,
                'load': 0.0,
                'co2': 0.0
            },
            'efficiency': {
                'peak': 0.0,
                'average': 0.0,
                'saved': 0.00
            }
        }
        # Merge energy data directly into ups_data so the template can access data.trends, data.total_energy, etc.
        ups_data.total_energy = energy_stats['total_energy']
        ups_data.total_cost = energy_stats['total_cost']
        ups_data.avg_load = energy_stats['avg_load']
        ups_data.co2 = energy_stats['co2']
        ups_data.trends = energy_stats['trends']
        ups_data.efficiency = energy_stats['efficiency']
        return render_template('dashboard/energy.html', data=ups_data, timezone=settings.TIMEZONE)

    # API Routes
    @app.route('/api/energy/data')
    def get_energy_data_api():
        try:
            days = request.args.get('days', type=int, default=1)
            data = get_energy_data(days)
            # Ensure we're not returning a Response object
            if hasattr(data, 'get_json'):
                data = data.get_json()
            return jsonify(data)
        except Exception as e:
            logger.error(f"Error getting energy data: {str(e)}", exc_info=True)
            return jsonify({'error': str(e)}), 500

    @app.route('/api/energy/cost-trend')
    def get_cost_trend_data():
        """API for energy cost chart data"""
        try:
            UPSDynamicData = get_ups_model()
            period_type = request.args.get('type', 'day')
            from_time = request.args.get('from_time')
            to_time = request.args.get('to_time')
            
            logger.debug(f"Getting cost trend data - type: {period_type}, from: {from_time}, to: {to_time}")
            
            tz = get_configured_timezone()
            if period_type == 'range':
                # Expect from_time and to_time in "YYYY-MM-DD" format for range selection.
                start_dt = datetime.strptime(from_time, '%Y-%m-%d')
                end_dt = datetime.strptime(to_time, '%Y-%m-%d')
                start_time = tz.localize(start_dt)
                end_time = tz.localize(end_dt.replace(hour=23, minute=59, second=59))
                series = get_cost_trend_for_range(start_time, end_time)
                return jsonify({'success': True, 'series': series})

            elif period_type == 'realtime':
                
                end_time = datetime.now(tz)
                start_time = end_time - timedelta(minutes=5) # 5 minutes ago
                data = UPSDynamicData.query\
                    .filter(
                        UPSDynamicData.timestamp_tz >= start_time,
                        UPSDynamicData.timestamp_tz <= end_time,
                        UPSDynamicData.ups_realpower.isnot(None)
                    ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                series = format_cost_series(data, 'realtime')

            elif period_type == 'today':
                # Hourly data for today
                now = datetime.now(tz)
                today = now.date()
                from_time_obj = datetime.strptime(from_time, '%H:%M').time()
                to_time_obj = datetime.strptime(to_time, '%H:%M').time()
                start_time = tz.localize(datetime.combine(today, from_time_obj))
                end_time = tz.localize(datetime.combine(today, to_time_obj))
                data = UPSDynamicData.query\
                    .filter(
                        UPSDynamicData.timestamp_tz >= start_time,
                        UPSDynamicData.timestamp_tz <= end_time,
                        UPSDynamicData.ups_realpower_hrs.isnot(None)
                    ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                series = format_cost_series(data, 'hrs')

            elif period_type == 'day':
                # 24 hours for the selected day
                date = datetime.strptime(from_time, '%Y-%m-%d').replace(tzinfo=tz)
                start_time = date.replace(hour=0, minute=0, second=0)
                end_time = date.replace(hour=23, minute=59, second=59)
                data = UPSDynamicData.query\
                    .filter(
                        UPSDynamicData.timestamp_tz >= start_time,
                        UPSDynamicData.timestamp_tz <= end_time,
                        UPSDynamicData.ups_realpower_hrs.isnot(None)
                    ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                series = format_cost_series(data, 'hrs')

            return jsonify({
                'success': True,
                'series': series
            })
            
        except Exception as e:
            logger.error(f"Error getting cost trend data: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            })

    @app.route('/api/energy/available-years')
    def get_available_years():
        """Return the years for which data is available, limited to the last 5"""
        try:
            UPSDynamicData = get_ups_model()
            with data_lock:
                years = UPSDynamicData.query\
                    .with_entities(func.extract('year', UPSDynamicData.timestamp_tz))\
                    .distinct()\
                    .order_by(func.extract('year', UPSDynamicData.timestamp_tz).desc())\
                    .limit(5)\
                    .all()
                
            return jsonify([int(year[0]) for year in years])
        except Exception as e:
            logger.error(f"Error getting available years: {str(e)}")
            return jsonify([])

    @app.route('/api/energy/detailed')
    def get_energy_detailed_data():
        try:
            from_time = request.args.get('from_time')
            to_time = request.args.get('to_time')
            detail_type = request.args.get('detail_type')  # 'day', 'hour', 'minute'
            
            tz = get_configured_timezone()
            
            if from_time.endswith("Z"):
                from_time = from_time.replace("Z", "+00:00")
            if to_time.endswith("Z"):
                to_time = to_time.replace("Z", "+00:00")

            start_time = datetime.fromisoformat(from_time).astimezone(tz)
            end_time = datetime.fromisoformat(to_time).astimezone(tz)
            
            UPSDynamicData = get_ups_model()
            
            if detail_type == 'day':
                # For the DateRange modal: show the 24 hours of the day
                data = UPSDynamicData.query\
                    .filter(
                        UPSDynamicData.timestamp_tz >= start_time,
                        UPSDynamicData.timestamp_tz <= end_time,
                        UPSDynamicData.ups_realpower_hrs.isnot(None)
                    )\
                    .order_by(UPSDynamicData.timestamp_tz.asc()).all()
                series = format_cost_series(data, 'hrs')
                
            elif detail_type == 'hour':
                # For the hour modal: show the 60 minutes
                data = UPSDynamicData.query\
                    .filter(
                        UPSDynamicData.timestamp_tz >= start_time,
                        UPSDynamicData.timestamp_tz <= end_time,
                        UPSDynamicData.ups_realpower.isnot(None)
                    )\
                    .order_by(UPSDynamicData.timestamp_tz.asc()).all()
                series = format_cost_series(data, 'minute')
            
            else:
                # For the main DateRange chart: show the days
                data = UPSDynamicData.query\
                    .filter(
                        UPSDynamicData.timestamp_tz >= start_time,
                        UPSDynamicData.timestamp_tz <= end_time,
                        UPSDynamicData.ups_realpower_days.isnot(None)
                    )\
                    .order_by(UPSDynamicData.timestamp_tz.asc()).all()
                series = format_cost_series(data, 'days')
            
            return jsonify({'success': True, 'series': series})
        except Exception as e:
            logger.error(f"Error getting detailed energy data: {str(e)}", exc_info=True)
            return jsonify({'success': False, 'error': str(e)}), 500

    return app

# Keep only necessary helper functions
def get_energy_rate():
    """Get the energy rate from settings"""
    try:
        config = VariableConfig.query.first()
        return float(config.price_per_kwh) if config and config.price_per_kwh else 0.25
    except Exception as e:
        logger.error(f"Error getting energy rate: {str(e)}")
        return 0.25  # Default fallback

def get_efficiency_factor():
    """Get the efficiency factor from settings"""
    try:
        config = VariableConfig.query.first()
        return float(config.efficiency) if config and hasattr(config, 'efficiency') else 0.06
    except Exception as e:
        logger.error(f"Error getting efficiency factor: {str(e)}")
        return 0.06  # Default fallback

def calculate_period_stats(data):
    """Calculate statistics for a period of data"""
    try:
        logger.debug(f"=== START calculate_period_stats ===")
        logger.debug(f"Calculating stats for {len(data)} records")
        
        total_energy = 0
        total_cost = 0
        total_load = 0
        total_co2 = 0
        count = 0
        peak_load = 0
        avg_load = 0
        
        # Get configurations from the database
        config = VariableConfig.query.first()
        rate = get_energy_rate()
        co2_factor = float(config.co2_factor) if config else 0.4
        efficiency_factor = get_efficiency_factor()
        
        for row in data:
            if row.ups_realpower_nominal and row.ups_load:
                count += 1
                load = float(row.ups_load)
                power = (float(row.ups_realpower_nominal) * load) / 100
                
                # Update the peak load
                peak_load = max(peak_load, load)
                total_load += load
                
                # Calculate energy in kWh
                if hasattr(row, 'ups_realpower_hrs'):
                    energy = power / 1000  # kWh per hour
                elif hasattr(row, 'ups_realpower_days'):
                    energy = (power * 24) / 1000  # kWh per day
                else:
                    energy = power / 1000  # Default a kWh per hour
                
                total_energy += energy
                total_cost += energy * rate
                total_co2 += energy * co2_factor
        
        # Calculate averages
        avg_load = total_load / count if count > 0 else 0
        
        # Calculate saved energy using the efficiency factor
        saved_energy = total_energy * efficiency_factor
        
        stats = {
            'totalEnergy': round(total_energy, 2),
            'totalCost': round(total_cost, 2),
            'avgLoad': round(avg_load, 1),
            'co2': round(total_co2, 2),
            'efficiency': {
                'peak': round(peak_load, 1),
                'average': round(avg_load, 1),
                'saved': round(saved_energy, 2)
            }
        }
        
        logger.debug(f"Calculated stats: {stats}")
        return stats
        
    except Exception as e:
        logger.error(f"Error in calculate_period_stats: {str(e)}", exc_info=True)
        raise 

def get_energy_data_for_period(start_time, end_time):
    """Helper function to calculate energy data for a period"""
    try:
        logger.debug(f"=== START get_energy_data_for_period ===")
        logger.debug(f"Parameters: start_time={start_time}, end_time={end_time}")
        
        UPSDynamicData = get_ups_model()
        
        # Calculate the same period in the past for trends
        period_length = end_time - start_time
        previous_start = start_time - period_length
        previous_end = start_time
        
        logger.debug(f"Previous period: {previous_start} to {previous_end}")
        
        # Query for the current period
        current_data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= start_time,
                UPSDynamicData.timestamp_tz <= end_time
            ).all()
        
        logger.debug(f"Found {len(current_data)} records for current period")
            
        # Query for the previous period
        previous_data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= previous_start,
                UPSDynamicData.timestamp_tz <= previous_end
            ).all()
            
        logger.debug(f"Found {len(previous_data)} records for previous period")
        
        # Calculate statistics for both periods
        current_stats = calculate_period_stats(current_data)
        previous_stats = calculate_period_stats(previous_data)
        
        logger.debug(f"Current stats: {current_stats}")
        logger.debug(f"Previous stats: {previous_stats}")
        
        # Calculate trends
        trends = {
            'energy': calculate_trend(current_stats['totalEnergy'], previous_stats['totalEnergy']),
            'cost': calculate_trend(current_stats['totalCost'], previous_stats['totalCost']),
            'load': calculate_trend(current_stats['avgLoad'], previous_stats['avgLoad']),
            'co2': calculate_trend(current_stats['co2'], previous_stats['co2'])
        }
        
        logger.debug(f"Calculated trends: {trends}")
        
        return {**current_stats, 'trends': trends}
        
    except Exception as e:
        logger.error(f"Error in get_energy_data_for_period: {str(e)}", exc_info=True)
        raise

def ensure_timezone_aware(dt):
    """Ensure datetime is timezone aware"""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=get_configured_timezone())
    return dt

def get_single_day_data(date):
    try:
        UPSDynamicData = get_ups_model()
        
        start_time = date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_time = date.replace(hour=23, minute=59, second=59, microsecond=999999)
        
        logger.debug(f"Getting single day data from {start_time} to {end_time}")
        
        hourly_data = UPSDynamicData.query\
            .filter(
                UPSDynamicData.timestamp_tz >= start_time,
                UPSDynamicData.timestamp_tz <= end_time,
                UPSDynamicData.ups_realpower_hrs.isnot(None)
            ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
            
        stats = calculate_energy_stats(hourly_data, 'hrs')
        
        # Add cost distribution
        rate = get_energy_rate()
        stats['cost_distribution'] = calculate_cost_distribution(hourly_data, rate)
        
        return stats
        
    except Exception as e:
        logger.error(f"Error in get_single_day_data: {str(e)}")
        return default_energy_response()

def get_realtime_trend_data(start_time, end_time):
    """Get real-time data for the chart"""
    UPSDynamicData = get_ups_model()
    data = UPSDynamicData.query\
        .filter(
            UPSDynamicData.timestamp_tz >= start_time,
            UPSDynamicData.timestamp_tz <= end_time,
            UPSDynamicData.ups_realpower.isnot(None)
        ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
        
    return format_trend_data(data, 'realtime')

def get_hourly_trend_data(start_time, end_time):
    """Get hourly data for the chart"""
    UPSDynamicData = get_ups_model()
    data = UPSDynamicData.query\
        .filter(
            UPSDynamicData.timestamp_tz >= start_time,
            UPSDynamicData.timestamp_tz <= end_time,
            UPSDynamicData.ups_realpower_hrs.isnot(None)
        ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
        
    return format_trend_data(data, 'hrs')

def format_trend_data(data, period_type):
    """Format data for the chart"""
    series = []
    rate = get_energy_rate()
    
    for row in data:
        timestamp = int(row.timestamp_tz.timestamp() * 1000)  # Timestamp in milliseconds
        
        if period_type == 'realtime':
            power = float(row.ups_realpower or 0)
        elif period_type == 'hrs':
            power = float(row.ups_realpower_hrs or 0)
        else:
            power = float(row.ups_realpower_days or 0)
            
        cost = (power * rate) / 1000  # Convert to kWh and calculate the cost
        
        series.append([timestamp, round(cost, 2)])
        
    return series

def format_cost_series(data, period_type):
    """Format data for the cost chart"""
    series = []
    rate = get_energy_rate()
    
    for row in data:
        timestamp = int(row.timestamp_tz.timestamp() * 1000)
        
        if period_type == 'minute':
            # For minute data
            power = float(row.ups_realpower or 0)
        elif period_type == 'hrs':
            # For hourly data
            power = float(row.ups_realpower_hrs or 0)
        elif period_type == 'days':
            # For daily data
            power = float(row.ups_realpower_days or 0)
            
        # Convert to kWh and calculate the cost
        cost = (power / 1000) * rate
        series.append([timestamp, round(cost, 4)])
    
    return series

def calculate_cost_distribution(data, rate):
    """
    Calculate the cost distribution grouped by time periods:
    - morning: 06:00-11:59
    - afternoon: 12:00-17:59
    - evening: 18:00-22:59
    - night: 23:00-05:59
    """
    # First collect the costs for each hour
    hourly_costs = {}
    for row in data:
        if not row.timestamp_tz:
            continue
            
        hour = row.timestamp_tz.hour
        energy = None
        if hasattr(row, 'ups_realpower_hrs') and row.ups_realpower_hrs:
            energy = float(row.ups_realpower_hrs) / 1000
        elif hasattr(row, 'ups_realpower_days') and row.ups_realpower_days:
            energy = float(row.ups_realpower_days) / 1000
            
        if energy is not None:
            cost = energy * rate
            if hour not in hourly_costs:
                hourly_costs[hour] = 0
            hourly_costs[hour] += cost

    # Then group by time periods
    distribution = {
        'morning': sum(hourly_costs.get(h, 0) for h in range(6, 12)),
        'afternoon': sum(hourly_costs.get(h, 0) for h in range(12, 18)),
        'evening': sum(hourly_costs.get(h, 0) for h in range(18, 23)),
        'night': sum(hourly_costs.get(h, 0) for h in range(23, 24)) + 
                 sum(hourly_costs.get(h, 0) for h in range(0, 6))
    }

    return distribution

def get_cost_trend_for_range(start_time, end_time):
    try:
        UPSDynamicData = get_ups_model()
        rate = get_energy_rate()
        # Updated: use hourly data (ups_realpower_hrs) for cost aggregation per day
        data = UPSDynamicData.query.with_entities(
            func.date(UPSDynamicData.timestamp_tz).label('day'),
            (rate * func.sum(UPSDynamicData.ups_realpower_hrs) / 1000).label('cost')
        ).filter(
            UPSDynamicData.timestamp_tz >= start_time,
            UPSDynamicData.timestamp_tz <= end_time,
            UPSDynamicData.ups_realpower_hrs.isnot(None)
        ).group_by(func.date(UPSDynamicData.timestamp_tz)).order_by(func.date(UPSDynamicData.timestamp_tz)).all()

        series = []
        for day, cost in data:
            if isinstance(day, str):
                dt = datetime.strptime(day, '%Y-%m-%d')
            else:
                dt = datetime.combine(day, datetime.min.time())
            timestamp = int(dt.timestamp() * 1000)
            series.append([timestamp, round(cost, 2)])
        return series
    except Exception as e:
        logger.error(f"Error in get_cost_trend_for_range: {str(e)}", exc_info=True)
        return []