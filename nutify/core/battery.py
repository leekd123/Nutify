from flask import jsonify, request, render_template
from datetime import datetime, timedelta
import logging
from .db_module import (
    get_ups_model, 
    data_lock, 
    db, 
    UPSEvent,
    get_ups_data
)
from sqlalchemy import func, and_
import pytz
from core.settings import get_configured_timezone, TIMEZONE, parse_time_format
from core.logger import battery_logger as logger

logger.info("🔋 Initializing battery")

POTENTIAL_BATTERY_METRICS = [
    'battery_charge',
    'battery_voltage', 
    'battery_runtime',
    'battery_type',
    'battery_date',
    'battery_mfr_date',
    'battery_temperature'
]

def get_available_battery_metrics():
    """
    Discover dynamically which battery metrics are available
    Returns: dict with available metrics and their latest values
    """
    try:
        UPSDynamicData = get_ups_model()
        available_metrics = {}
        
        # Log of raw data from the UPS
        ups_data = get_ups_data()
        logger.debug(f"🔍 Raw UPS data: {ups_data.__dict__}")
        
        # Complete list of possible battery metrics
        battery_metrics = [
            'battery_charge', 'battery_charge_low', 'battery_charge_warning',
            'battery_voltage', 'battery_voltage_nominal', 'battery_current',
            'battery_temperature', 'battery_runtime', 'battery_runtime_low',
            'battery_alarm_threshold', 'battery_date', 'battery_type',
            'battery_mfr_date', 'battery_packs', 'battery_packs_external',
            'battery_protection'
        ]
        
        # Check which are actually available
        for metric in battery_metrics:
            if hasattr(UPSDynamicData, metric):
                latest = UPSDynamicData.query.filter(
                    getattr(UPSDynamicData, metric).isnot(None)
                ).order_by(UPSDynamicData.timestamp_tz.desc()).first()
                
                if latest:
                    # Retrieve the value
                    value = getattr(latest, metric)
                    # If the metric is battery_date or battery_mfr_date, convert it to string
                    if metric in ['battery_date', 'battery_mfr_date'] and value is not None:
                        try:
                            value = value.isoformat()
                        except Exception as ex:
                            logger.warning(f"Unable to format {metric}: {ex}")
                    logger.debug(f"🔍 Found metric {metric}: {value}")
                    available_metrics[metric] = value
        
        # Fallback: if battery_date or battery_mfr_date not found in available_metrics,
        # use the value from ups_data.__dict__ if present
        for key in ['battery_date', 'battery_mfr_date']:
            if key not in available_metrics and key in ups_data.__dict__:
                value = ups_data.__dict__[key]
                if hasattr(value, 'isoformat'):
                    try:
                        value = value.isoformat()
                    except Exception as ex:
                        logger.warning(f"Unable to format {key}: {ex}")
                logger.debug(f"🔍 Fallback for metric {key}: {value}")
                available_metrics[key] = value
        
        return available_metrics
    
    except Exception as e:
        logger.error(f"Error getting available battery metrics: {str(e)}")
        return {}

def get_battery_stats(period='day', from_time=None, to_time=None, selected_date=None):
    """
    Calculate battery statistics for the specified period
    """
    try:
        tz = get_configured_timezone()
        now = datetime.now(tz)
        logger.debug(f"Getting battery stats for period={period}, from={from_time}, to={to_time}")
        
        # Standardize time range calculation
        if period == 'day' and selected_date is not None:
            # selected_date already has the timezone, use directly replace
            start_time = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
            end_time = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)
            logger.debug(f"Select Day stats range - Start: {start_time}, End: {end_time}")
        elif period == 'day' and from_time and to_time:
            today = now.date()
            from_time_obj = parse_time_format(from_time, datetime.strptime("00:00", '%H:%M').time())
            to_time_obj = parse_time_format(to_time, now.time())
            start_time = tz.localize(datetime.combine(today, from_time_obj))
            end_time = tz.localize(datetime.combine(today, to_time_obj))
        elif period == 'range' and from_time and to_time:
            start_time = tz.localize(datetime.strptime(from_time, '%Y-%m-%d'))
            end_time = tz.localize(datetime.strptime(to_time, '%Y-%m-%d')).replace(
                hour=23, minute=59, second=59, microsecond=999999)
        else:
            start_time = now - timedelta(days=1)
            end_time = now

        logger.debug(f"Query period: {start_time} to {end_time}")

        # Query with the correct period
        query = get_ups_model().query.filter(
            get_ups_model().timestamp_tz >= start_time,
            get_ups_model().timestamp_tz <= end_time
        )
        
        # Initialize all possible metrics with default values
        stats = {
            'battery_charge': {'min': None, 'max': None, 'avg': None},
            'battery_charge_low': {'min': None, 'max': None, 'avg': None},
            'battery_charge_warning': {'min': None, 'max': None, 'avg': None},
            'battery_voltage': {'min': None, 'max': None, 'avg': None},
            'battery_voltage_nominal': {'min': None, 'max': None, 'avg': None},
            'battery_current': {'min': None, 'max': None, 'avg': None},
            'battery_temperature': {'min': None, 'max': None, 'avg': None},
            'battery_runtime': {'min': None, 'max': None, 'avg': None},
            'battery_runtime_low': {'min': None, 'max': None, 'avg': None},
            'battery_alarm_threshold': {'min': None, 'max': None, 'avg': None}
        }
        
        # Calculate statistics only for available metrics
        for metric in stats.keys():
            if hasattr(get_ups_model(), metric):
                column = getattr(get_ups_model(), metric)
                result = query.with_entities(
                    func.min(column).label('min'),
                    func.max(column).label('max'),
                    func.avg(column).label('avg')
                ).filter(column.isnot(None)).first()
                
                if result and result.min is not None:
                    stats[metric] = {
                        'min': float(result.min),
                        'max': float(result.max),
                        'avg': float(result.avg),
                        'available': True
                    }
        
        # Calculate statistics specific to battery events
        battery_events = UPSEvent.query.filter(
            UPSEvent.timestamp_tz >= start_time,
            UPSEvent.timestamp_tz <= end_time,
            UPSEvent.event_type.in_(['ONBATT', 'LOWBATT', 'ONLINE'])
        ).order_by(UPSEvent.timestamp_tz.asc()).all()
        
        total_duration = 0
        longest_duration = 0
        battery_count = 0
        
        # Group events by pairs of ONBATT-ONLINE
        current_start = None
        for event in battery_events:
            if event.event_type == 'ONBATT':
                current_start = event.timestamp_tz
                battery_count += 1
            elif event.event_type == 'ONLINE' and current_start:
                duration = (event.timestamp_tz - current_start).total_seconds()
                total_duration += duration
                longest_duration = max(longest_duration, duration)
                current_start = None
        
        stats['events'] = {
            'count': battery_count,
            'total_duration': total_duration,
            'longest_duration': longest_duration,
            'available': True
        }
        
        # Log of results
        logger.debug(f"Stats calculated: {stats}")
        return stats
        
    except Exception as e:
        logger.error(f"Error calculating battery stats: {str(e)}")
        return {}

def get_battery_history(period='day', from_date=None, to_date=None, selected_date=None):
    """
    Retrieve the battery history data for graphs
    Args:
        period: 'day', 'range'
        from_date: initial date (for period='range' or time for period='day')
        to_date: final date (for period='range' or time for period='day')
    """
    try:
        logger.debug(f"🔍 get_battery_history called with: period={period}, from={from_date}, to={to_date}")
        
        UPSDynamicData = get_ups_model()
        tz = get_configured_timezone()
        now = datetime.now(tz)

        if period == 'day' and selected_date is not None:
            start_time = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
            end_time = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)
            target_points = 96  # 96 points = 1 point every 15 minutes
            logger.debug(f"Select Day history range - Start: {start_time}, End: {end_time}")
        elif period == 'day' and from_date and to_date:
            today = now.date()
            from_time = parse_time_format(from_date, datetime.strptime("00:00", '%H:%M').time())
            to_time = parse_time_format(to_date, now.time())
            start_time = tz.localize(datetime.combine(today, from_time))
            end_time = tz.localize(datetime.combine(today, to_time))
            target_points = 96
        elif period == 'range' and from_date and to_date:
            logger.debug(f"Processing date range {from_date} - {to_date}")
            tz = get_configured_timezone()
            start_time = tz.localize(datetime.strptime(from_date, '%Y-%m-%d'))
            end_time = tz.localize(datetime.strptime(to_date, '%Y-%m-%d')).replace(
                hour=23, minute=59, second=59, microsecond=999999)
            target_points = 180  # One point every 4 hours (or adjust as needed)
        elif period == 'realtime':
            logger.debug("Processing realtime period for history, using last 30 seconds")
            start_time = now - timedelta(seconds=30)
            end_time = now
            target_points = 30
        else:
            # Fallback: if no period-specific parameters are provided, use last 24 hours
            start_time = now - timedelta(days=1)
            end_time = now
            target_points = 96

        history = {}
        metrics = [
            'battery_charge',
            'battery_runtime', 
            'battery_voltage',
            'battery_temperature'
        ]
        
        for metric in metrics:
            if hasattr(UPSDynamicData, metric):
                data = UPSDynamicData.query.filter(
                    UPSDynamicData.timestamp_tz >= start_time,
                    UPSDynamicData.timestamp_tz <= end_time,
                    getattr(UPSDynamicData, metric).isnot(None)
                ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                
                logger.debug(f"📊 Metric {metric}: found {len(data)} records")
                logger.debug(f"🔍 Query for {metric}: start={start_time}, end={end_time}")
                if metric == 'battery_temperature':
                    logger.debug(f"🌡️ First 5 temperature values: {[getattr(d, metric) for d in data[:5]]}")
                    logger.debug(f"🌡️ Last 5 temperature values: {[getattr(d, metric) for d in data[-5:]]}")
                
                if data:
                    # Calculate the sampling interval
                    step = max(1, len(data) // target_points)
                    
                    # Sample the data
                    sampled_data = data[::step]
                    
                    history[metric] = [{
                        'timestamp': entry.timestamp_tz.isoformat(),
                        'value': float(getattr(entry, metric))
                    } for entry in sampled_data]
                    logger.debug(f"🔢 {metric}: first value={history[metric][0]['value']}, last value={history[metric][-1]['value']}")
                else:
                    logger.debug(f"⚠️ No data found for {metric}")
                    history[metric] = []

        # Battery events (remain all because they are discrete events)
        events = UPSEvent.query.filter(
            UPSEvent.timestamp_tz >= start_time,
            UPSEvent.timestamp_tz <= end_time,
            UPSEvent.event_type.in_(['ONBATT', 'LOWBATT', 'ONLINE'])
        ).order_by(UPSEvent.timestamp_tz.asc()).all()

        history['events'] = [{
            'type': event.event_type,
            'start_time': event.timestamp_tz.isoformat(),
            'end_time': event.timestamp_tz_end.isoformat() if event.timestamp_tz_end else event.timestamp_tz.isoformat()
        } for event in events]

        logger.debug(f"📈 Available metrics in the response: {list(history.keys())}")
        return history
        
    except Exception as e:
        logger.error(f"❌ Error in get_battery_history: {str(e)}", exc_info=True)
        return {
            'battery_charge': [],
            'battery_runtime': [],
            'battery_voltage': [],
            'battery_temperature': [],
            'events': []
        }

def calculate_battery_health(metrics):
    """
    Calculate the actual battery health based on available metrics
    Returns: battery health percentage (0-100) or None if there is not enough data
    """
    try:
        health_components = []
        total_weight = 0
        
        # 1. Voltage (40% weight if available)
        if all(key in metrics for key in ['battery_voltage', 'battery_voltage_nominal']):
            try:
                voltage_ratio = (float(metrics['battery_voltage']) / float(metrics['battery_voltage_nominal']))
                voltage_health = min(100, voltage_ratio * 100)
                health_components.append(('voltage', voltage_health, 0.4))
                total_weight += 0.4
                logger.debug(f"Voltage Health: {voltage_health:.1f}% (Current: {metrics['battery_voltage']}V, Nominal: {metrics['battery_voltage_nominal']}V)")
            except (ValueError, ZeroDivisionError) as e:
                logger.warning(f"Could not calculate voltage health: {str(e)}")

        # 2. Runtime (40% weight if available)
        if all(key in metrics for key in ['battery_runtime', 'battery_runtime_low']):
            try:
                runtime_ratio = float(metrics['battery_runtime']) / float(metrics['battery_runtime_low'])
                runtime_health = min(100, runtime_ratio * 50)
                health_components.append(('runtime', runtime_health, 0.4))
                total_weight += 0.4
                logger.debug(f"Runtime Health: {runtime_health:.1f}% (Current: {metrics['battery_runtime']}s, Low: {metrics['battery_runtime_low']}s)")
            except (ValueError, ZeroDivisionError) as e:
                logger.warning(f"Could not calculate runtime health: {str(e)}")

        # 3. Charge (20% weight if available)
        if 'battery_charge' in metrics:
            try:
                charge_health = float(metrics['battery_charge'])
                health_components.append(('charge', charge_health, 0.2))
                total_weight += 0.2
                logger.debug(f"Charge Health: {charge_health:.1f}%")
            except ValueError as e:
                logger.warning(f"Could not calculate charge health: {str(e)}")

        # If we don't have enough data, return None
        if not health_components or total_weight == 0:
            logger.warning("Not enough data to calculate battery health")
            return None

        # Recalculate weights based on available metrics
        normalized_components = [
            (name, value, weight/total_weight) 
            for name, value, weight in health_components
        ]

        # Final weighted calculation
        health = sum(value * norm_weight for _, value, norm_weight in normalized_components)
        
        # Detailed calculation log
        logger.debug("Battery Health Calculation:")
        for name, value, weight in normalized_components:
            logger.debug(f"  - {name}: {value:.1f}% (weight: {weight:.2f})")
        logger.debug(f"Final Health: {health:.1f}%")

        return round(min(100, max(0, health)), 1)

    except Exception as e:
        logger.error(f"Error calculating battery health: {str(e)}")
        return None

def format_ups_status(status):
    """
    Format UPS status codes into human-readable text.
    
    Args:
        status (str): UPS status code (e.g., 'OL', 'OB', 'LB')
        
    Returns:
        str: Human-readable status text
    """
    if not status:
        return 'Unknown'
    
    states = {
        'OL': 'Online',
        'OB': 'On Battery',
        'LB': 'Low Battery',
        'HB': 'High Battery',
        'RB': 'Replace Battery',
        'CHRG': 'Charging',
        'DISCHRG': 'Discharging',
        'BYPASS': 'Bypass Mode',
        'CAL': 'Calibration',
        'OFF': 'Offline',
        'OVER': 'Overloaded',
        'TRIM': 'Trimming Voltage',
        'BOOST': 'Boosting Voltage'
    }
    
    return ' + '.join([states.get(s, s) for s in status.split()])

def format_battery_type(battery_type):
    """
    Format battery type codes into human-readable text.
    
    Args:
        battery_type (str): Battery type code (e.g., 'PbAc')
        
    Returns:
        str: Human-readable battery type
    """
    if not battery_type:
        return 'Unknown'
    
    types = {
        'PbAc': 'Lead Acid',
        'Li': 'Lithium Ion',
        'LiP': 'Lithium Polymer',
        'NiCd': 'Nickel Cadmium',
        'NiMH': 'Nickel Metal Hydride',
        'SLA': 'Sealed Lead Acid',
        'VRLA': 'Valve Regulated Lead Acid',
        'AGM': 'Absorbed Glass Mat',
        'Gel': 'Gel Cell',
        'Flooded': 'Flooded Lead Acid'
    }
    
    return types.get(battery_type, battery_type)

def register_routes(app):
    """Register all routes related to the battery"""
    
    @app.route('/battery')
    def battery_page():
        """Render the battery page"""
        data = get_ups_data()
        metrics = get_available_battery_metrics()
        stats = get_battery_stats()
        battery_health = calculate_battery_health(metrics) if metrics else None
        
        # Format UPS status and battery type
        formatted_status = None
        formatted_battery_type = None
        
        if hasattr(data, 'ups_status') and data.ups_status:
            formatted_status = format_ups_status(data.ups_status)
        
        if hasattr(data, 'battery_type') and data.battery_type:
            formatted_battery_type = format_battery_type(data.battery_type)
        
        return render_template('dashboard/battery.html', 
                             data=data,
                             metrics=metrics,
                             stats=stats,
                             battery_health=battery_health,
                             timezone=TIMEZONE,
                             formatted_status=formatted_status,
                             formatted_battery_type=formatted_battery_type)
    
    @app.route('/api/battery/metrics')
    def api_battery_metrics():
        """API for available metrics"""
        metrics = get_available_battery_metrics()
        return jsonify({'success': True, 'data': metrics})
    
    @app.route('/api/battery/stats')
    def api_battery_stats():
        """API for statistics"""
        period = request.args.get('period', 'day')
        from_time = request.args.get('from_time')
        to_time = request.args.get('to_time')
        if period == 'day':
            selected_date = request.args.get('selected_date')
            tz = get_configured_timezone()
            if selected_date:
                try:
                    selected_date_dt = datetime.strptime(selected_date, '%Y-%m-%d')
                    if selected_date_dt.tzinfo is None:
                        selected_date_dt = tz.localize(selected_date_dt)
                except ValueError:
                    logger.error(f"Invalid selected_date format: {selected_date}")
                    selected_date_dt = datetime.now(tz)
            else:
                selected_date_dt = datetime.now(tz)
            stats = get_battery_stats(period, from_time, to_time, selected_date_dt)
        else:
            stats = get_battery_stats(period, from_time, to_time)
        return jsonify({'success': True, 'data': stats})
    
    @app.route('/api/battery/history')
    def api_battery_history():
        """API for history data"""
        period = request.args.get('period', 'day')
        from_time = request.args.get('from_time')
        to_time = request.args.get('to_time')
        selected_date = request.args.get('selected_date')
        if period == 'day' and selected_date:
            tz = get_configured_timezone()
            try:
                selected_date_dt = datetime.strptime(selected_date, '%Y-%m-%d')
                if selected_date_dt.tzinfo is None:
                    selected_date_dt = tz.localize(selected_date_dt)
            except ValueError:
                logger.error(f"Invalid selected_date format in history: {selected_date}")
                selected_date_dt = None
        else:
            selected_date_dt = None

        history = get_battery_history(period, from_time, to_time, selected_date_dt)
        return jsonify({'success': True, 'data': history})

    def calculate_activity_level(event_count, avg_charge, battery_events):
        """
        Calculate the activity level based on various factors
        Returns: 'low', 'medium', or 'high'
        """
        score = 0
        
        # More events = more activity
        if event_count > 1000: score += 3
        elif event_count > 500: score += 2
        elif event_count > 100: score += 1
        
        # Battery events weigh more
        if battery_events > 5: score += 3
        elif battery_events > 2: score += 2
        elif battery_events > 0: score += 1
        
        # Charge variations
        if avg_charge is not None:
            if avg_charge < 50: score += 2
            elif avg_charge < 80: score += 1
        
        if score >= 5: return 'high'
        if score >= 3: return 'medium'
        return 'low'

    return app 