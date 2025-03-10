from flask import jsonify, request, render_template
from datetime import datetime, timedelta
from core.logger import power_logger as logger
logger.info("💪 Initialization power")

from .db_module import (
    get_ups_model, 
    data_lock, 
    db, 
    get_ups_data
)
from sqlalchemy import func, and_
import pytz
from core.settings import get_configured_timezone, TIMEZONE, parse_time_format

# List of potential power-related metrics
POTENTIAL_POWER_METRICS = [
    # UPS Power Metrics
    'ups_power',                # UPS measured power in watts
    'ups_realpower',           # UPS real power consumption
    'ups_realpower_nominal',   # UPS nominal real power
    'ups_realpower_hrs',       # UPS real power hours
    'ups_realpower_days',      # UPS real power days
    'ups_load',                # UPS load percentage
    'ups_efficiency',          # UPS efficiency
    'ups_power_nominal',       # UPS nominal power
    
    # Input Metrics
    'input_voltage',           # Input voltage
    'input_voltage_nominal',   # Nominal input voltage
    'input_voltage_minimum',   # Minimum input voltage
    'input_voltage_maximum',   # Maximum input voltage
    'input_transfer_low',      # Low transfer voltage
    'input_transfer_high',     # High transfer voltage
    'input_frequency',         # Input frequency
    'input_frequency_nominal', # Nominal input frequency
    'input_current',          # Input current
    'input_current_nominal',  # Nominal input current
    'input_realpower',        # Input real power
    'input_realpower_nominal', # Nominal input real power
    
    # Output Metrics
    'output_voltage',         # Output voltage
    'output_voltage_nominal', # Nominal output voltage
    'output_frequency',       # Output frequency
    'output_frequency_nominal', # Nominal output frequency
    'output_current',         # Output current
    'output_current_nominal'  # Nominal output current
]

def get_available_power_metrics():
    """
    Retrieve the list of power metrics available from the UPS dynamic data.
    """
    try:
        UPSDynamicData = get_ups_model()
        available_metrics = {}
        
        # Get the latest record from dynamic data table
        latest = UPSDynamicData.query.order_by(UPSDynamicData.timestamp_tz.desc()).first()
        if not latest:
            logger.warning("No UPS data found in database")
            return available_metrics

        # Check each potential metric
        for metric in POTENTIAL_POWER_METRICS:
            if hasattr(latest, metric):
                value = getattr(latest, metric)
                if value is not None:
                    try:
                        # Convert to float for uniformity
                        float_value = float(value)
                        available_metrics[metric] = float_value
                    except (ValueError, TypeError) as e:
                        logger.warning(f"Could not convert {metric} value to float: {e}")
                        continue

        # Add manual nominal power from settings if not available from UPS
        # Check in order: ups_realpower_nominal, ups_power_nominal, then settings
        if 'ups_realpower_nominal' not in available_metrics:
            if 'ups_power_nominal' in available_metrics:
                # Use ups_power_nominal as fallback
                available_metrics['ups_realpower_nominal'] = available_metrics['ups_power_nominal']
                logger.info("Using ups_power_nominal as fallback for nominal power")
            else:
                # Use settings as last resort
                from core.settings import UPS_REALPOWER_NOMINAL
                available_metrics['ups_realpower_nominal'] = float(UPS_REALPOWER_NOMINAL)
                logger.info("Using manual nominal power from settings")

        # Remove ups_power if present, we'll use only ups_realpower
        if 'ups_power' in available_metrics:
            del available_metrics['ups_power']
            logger.debug("Removed ups_power, using ups_realpower instead")

        logger.info(f"Found {len(available_metrics)} available power metrics")
        logger.debug(f"Available metrics: {available_metrics}")
        return available_metrics

    except Exception as e:
        logger.error(f"Error getting available power metrics: {str(e)}")
        return {}

def get_power_stats(period='day', from_time=None, to_time=None, selected_date=None):
    """
    Calculate power statistics for each available metric.
    """
    try:
        tz = get_configured_timezone()
        now = datetime.now(tz)
        logger.debug(f"Getting power stats - Period: {period}, From: {from_time}, To: {to_time}, Selected: {selected_date}")
        
        # Standardize time range calculation
        if period == 'day' and selected_date is not None:  # Case SELECT DAY
            # selected_date already has the timezone, we use it directly
            start_time = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
            end_time = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)
            logger.debug(f"Select Day stats range - Start: {start_time}, End: {end_time}")
        elif period == 'day':
            today = now.date()
            if from_time and to_time:
                # Case "today" or specific hourly range
                try:
                    from_time_obj = parse_time_format(from_time, datetime.strptime("00:00", '%H:%M').time())
                    to_time_obj = parse_time_format(to_time, now.time())
                    
                    # Create datetime with timezone
                    start_time = tz.localize(datetime.combine(today, from_time_obj))
                    end_time = tz.localize(datetime.combine(today, to_time_obj))
                    
                    logger.debug(f"Today time range - From: {start_time}, To: {end_time}")
                except ValueError as e:
                    logger.error(f"Error parsing time: {e}")
                    # Fallback to the entire day
                    start_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
                    end_time = now
            else:
                # If not specified, use the entire day
                start_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
                end_time = now
        elif period == 'range':
            start_time = tz.localize(datetime.strptime(from_time, '%Y-%m-%d'))
            end_time = tz.localize(datetime.strptime(to_time, '%Y-%m-%d')).replace(
                hour=23, minute=59, second=59, microsecond=999999)
        else:
            start_time = now - timedelta(days=1)
            end_time = now

        logger.debug(f"Final time range - Start: {start_time}, End: {end_time}")

        # Get available metrics first
        available_metrics = get_available_power_metrics()
        
        # Initialize stats dictionary
        stats = {}
        model = get_ups_model()

        # Calculate stats for each metric
        for metric in available_metrics.keys():
            if metric == 'ups_realpower':
                # Calculate total energy using ups_realpower_hrs
                total_energy_query = model.query.filter(
                    model.timestamp_tz >= start_time,
                    model.timestamp_tz <= end_time,
                    model.ups_realpower_hrs.isnot(None)
                ).with_entities(func.sum(model.ups_realpower_hrs))
                
                total_energy = total_energy_query.scalar()
                logger.debug(f"Total energy query result: {total_energy}")

                # Calculate min, max, avg using ups_realpower
                stats_query = model.query.filter(
                    model.timestamp_tz >= start_time,
                    model.timestamp_tz <= end_time,
                    model.ups_realpower.isnot(None)
                ).with_entities(
                    func.min(model.ups_realpower).label('min'),
                    func.max(model.ups_realpower).label('max'),
                    func.avg(model.ups_realpower).label('avg')
                )
                
                result = stats_query.first()
                logger.debug(f"Stats query result: {result}")

                stats[metric] = {
                    'total_energy': float(total_energy) if total_energy is not None else 0,
                    'current': float(available_metrics[metric]),
                    'min': float(result.min) if result and result.min is not None else 0,
                    'max': float(result.max) if result and result.max is not None else 0,
                    'avg': float(result.avg) if result and result.avg is not None else 0,
                    'available': True if result and result.min is not None else False
                }
                
                logger.debug(f"Final stats for {metric}: {stats[metric]}")
            elif metric == 'ups_realpower_nominal' and not hasattr(model, 'ups_realpower_nominal'):
                # Special handling for ups_realpower_nominal when it was added as a fallback
                # but does not exist as a column in the table
                stats[metric] = {
                    'min': float(available_metrics[metric]),
                    'max': float(available_metrics[metric]),
                    'avg': float(available_metrics[metric]),
                    'current': float(available_metrics[metric]),
                    'available': True
                }
                logger.debug(f"Using fallback value for {metric}: {stats[metric]}")
            else:
                # For other metrics
                try:
                    # Check if the metric exists as a column in the table
                    if hasattr(model, metric):
                        result = model.query.filter(
                            model.timestamp_tz >= start_time,
                            model.timestamp_tz <= end_time,
                            getattr(model, metric).isnot(None)
                        ).with_entities(
                            func.min(getattr(model, metric)).label('min'),
                            func.max(getattr(model, metric)).label('max'),
                            func.avg(getattr(model, metric)).label('avg')
                        ).first()

                        stats[metric] = {
                            'min': float(result.min) if result and result.min is not None else 0,
                            'max': float(result.max) if result and result.max is not None else 0,
                            'avg': float(result.avg) if result and result.avg is not None else 0,
                            'current': float(available_metrics[metric]),
                            'available': True if result and result.min is not None else False
                        }
                    else:
                        # If the metric does not exist as a column, use the current value
                        stats[metric] = {
                            'min': float(available_metrics[metric]),
                            'max': float(available_metrics[metric]),
                            'avg': float(available_metrics[metric]),
                            'current': float(available_metrics[metric]),
                            'available': True
                        }
                        logger.debug(f"Using current value for {metric}: {stats[metric]}")
                except Exception as e:
                    logger.warning(f"Error calculating stats for {metric}: {str(e)}")
                    stats[metric] = {
                        'min': 0,
                        'max': 0,
                        'avg': 0,
                        'current': float(available_metrics[metric]),
                        'available': False
                    }

        return stats

    except Exception as e:
        logger.error(f"Error calculating power stats: {str(e)}")
        return {}

def get_power_history(period='day', from_date=None, to_date=None, selected_date=None):
    """
    Retrieve historical power data (for ups_power, ups_realpower, input_voltage)
    to display in a chart.
    """
    try:
        model = get_ups_model()
        tz = get_configured_timezone()
        now = datetime.now(tz)

        # Set time range based on period
        if period == 'day' and selected_date is not None:
            start_time = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
            end_time = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)
            target_points = 96
        elif period == 'day' and from_date and to_date:
            today = now.date()
            if from_date and to_date:
                # Case "today" or specific hourly range
                try:
                    from_time_obj = parse_time_format(from_date, datetime.strptime("00:00", '%H:%M').time())
                    to_time_obj = parse_time_format(to_date, now.time())
                    
                    # Create datetime with timezone
                    start_time = tz.localize(datetime.combine(today, from_time_obj))
                    end_time = tz.localize(datetime.combine(today, to_time_obj))
                    
                    logger.debug(f"Today time range - From: {start_time}, To: {end_time}")
                except ValueError as e:
                    logger.error(f"Error parsing time: {e}")
                    # Fallback to the entire day
                    start_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
                    end_time = now
            else:
                # If not specified, use the entire day
                start_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
                end_time = now
            target_points = 96
        elif period == 'range' and from_date and to_date:
            start_time = tz.localize(datetime.strptime(from_date, '%Y-%m-%d'))
            end_time = tz.localize(datetime.strptime(to_date, '%Y-%m-%d')).replace(
                hour=23, minute=59, second=59, microsecond=999999)
            target_points = 180
        else:
            start_time = now - timedelta(days=1)
            end_time = now
            target_points = 96

        history = {}
        metrics = ['ups_power', 'ups_realpower', 'input_voltage']

        for metric in metrics:
            if hasattr(model, metric):
                data = model.query.filter(
                    model.timestamp_tz >= start_time,
                    model.timestamp_tz <= end_time,
                    getattr(model, metric).isnot(None)
                ).order_by(model.timestamp_tz.asc()).all()
                if data:
                    step = max(1, len(data) // target_points)
                    sampled_data = data[::step]
                    history[metric] = [{
                        'timestamp': entry.timestamp_tz.isoformat(),
                        'value': float(getattr(entry, metric))
                    } for entry in sampled_data]
                else:
                    history[metric] = []
        return history

    except Exception as e:
        logger.error(f"Error getting power history: {str(e)}")
        return {
            'ups_power': [],
            'ups_realpower': [],
            'input_voltage': []
        }

def register_routes(app):
    """
    Register all web routes and API endpoints related to power data.
    
    Routes include:
      - /power (web page for power management)
      - /api/power/metrics (available power metrics)
      - /api/power/stats (power statistics)
      - /api/power/history (historical power data)
    
    Note: Real-time data is now provided by /api/ups/cache
    
    Args:
        app: The Flask application instance.
        
    Returns:
        app: Modified Flask application with power routes registered.
    """
    @app.route('/power')
    def power_page():
        """
        Render the Power Management page.
        Obtains UPS data, available power metrics, statistics and history data,
        then renders the 'dashboard/power.html' template.
        """
        data = get_ups_data()
        metrics = get_available_power_metrics()
        stats = get_power_stats()
        history = get_power_history()
        
        # Import UPS_REALPOWER_NOMINAL from settings
        from core.settings import UPS_REALPOWER_NOMINAL
        
        # Format UPS status if available
        formatted_status = None
        if hasattr(data, 'ups_status') and data.ups_status:
            formatted_status = format_ups_status(data.ups_status)
        
        return render_template('dashboard/power.html',
                               data=data,
                               metrics=metrics,
                               stats=stats,
                               history=history,
                               timezone=TIMEZONE,
                               ups_nominal_power=UPS_REALPOWER_NOMINAL,
                               formatted_status=formatted_status)  # Pass the formatted status

    @app.route('/api/power/metrics')
    def api_power_metrics():
        """
        API endpoint to retrieve available power metrics.
        
        Returns:
            JSON response with a dictionary of available power metrics.
        """
        metrics = get_available_power_metrics()
        return jsonify({'success': True, 'data': metrics})

    @app.route('/api/power/stats')
    def api_power_stats():
        """
        API endpoint to retrieve power statistics.
        
        Query parameters:
          - period: The time period type ('day', 'range', etc.)
          - from_time, to_time: Time range (if applicable)
          - selected_date: Specific date (if applicable)
          
        Returns:
            JSON response with a dictionary of power statistics.
        """
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
            stats = get_power_stats(period, from_time, to_time, selected_date_dt)
        else:
            stats = get_power_stats(period, from_time, to_time)
        return jsonify({'success': True, 'data': stats})

    @app.route('/api/power/history')
    def api_power_history():
        """API for historical data"""
        period = request.args.get('period', 'day')
        from_time = request.args.get('from_time')
        to_time = request.args.get('to_time')
        selected_day = request.args.get('selected_day')
        
        history = get_power_history(period, from_time, to_time, selected_day)
        return jsonify({'success': True, 'data': history})

    return app 

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