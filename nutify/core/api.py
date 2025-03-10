from flask import jsonify, request, current_app, send_file
from marshmallow import Schema, fields, ValidationError, post_load
import datetime
import json
from dateutil import parser
import re
from .settings import (  
    LOG, LOG_LEVEL, LOG_WERKZEUG,
    get_configured_timezone, TIMEZONE
)
from .db_module import (
    db, data_lock, get_ups_data, get_supported_value, get_ups_model,
    UPSConnectionError, UPSCommandError, UPSDataError, create_static_model,
    VariableConfig, UPSEvent, UPSCommand, ReportSchedule, ups_data_cache
)
from .upscmd import get_ups_commands, execute_command, get_command_stats
from .mail import (
    MailConfig, test_email_config, save_mail_config,
    init_notification_settings, get_notification_settings, test_notification,
    NotificationSettings
)
from .upsmon_client import handle_nut_event, get_event_history, get_events_table, acknowledge_event
import os
from datetime import datetime, timedelta
from .upsrw import get_ups_variables, set_ups_variable, get_variable_history, clear_variable_history, UPSVariable
from .voltage import get_available_voltage_metrics, get_voltage_stats, get_voltage_history
import configparser
import pytz
from core.logger import web_logger as logger
import tempfile, zipfile
from core.options import get_filtered_logs, clear_logs
from .report import report_manager
logger.info("🐝 Initializing api")

class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        try:
            if isinstance(obj, datetime):
                return obj.isoformat()
            if hasattr(obj, 'isoformat'):
                return obj.isoformat()
            return super().default(obj)
        except Exception:
            return str(obj)

def jsonify_pretty(*args, **kwargs):
    """ Formats the JSON in a readable way"""
    response = jsonify(*args, **kwargs)
    response.set_data(json.dumps(response.get_json(), indent=2))
    return response


def get_historical_data(start_time, end_time):
    try:
        UPSData = get_ups_model()
        logger.debug(f"Querying data from {start_time} to {end_time}")
        data = UPSData.query.filter(
            UPSData.timestamp_tz.between(start_time, end_time)
        ).order_by(UPSData.timestamp_tz.asc()).all()
        logger.debug(f"Found {len(data)} records")
        result = []
        for entry in data:
            try:
                nominal_power = entry.ups_realpower_nominal if entry.ups_realpower_nominal is not None else 960
                load = entry.ups_load if entry.ups_load is not None else 0
                calculated_power = (nominal_power * load) / 100
                item = {
                    'timestamp': entry.timestamp_tz.isoformat(),
                    'input_voltage': float(entry.input_voltage if entry.input_voltage is not None else 0),
                    'power': float(calculated_power),
                    'energy': float(calculated_power),
                    'battery_charge': float(entry.battery_charge if entry.battery_charge is not None else 0)
                }
                result.append(item)
            except (ValueError, TypeError, AttributeError) as e:
                logger.error(f"Error processing record {entry.id}: {e}")
                continue
        logger.debug(f"Processed {len(result)} valid records")
        return result
    except Exception as e:
        logger.error(f"Error retrieving historical data: {e}")
        return []

def validate_datetime(date_text):
    try:
        return bool(parser.parse(date_text))
    except ValueError:
        return False

def sanitize_input(value):
    if isinstance(value, str):
        return re.sub(r'[^a-zA-Z0-9\s\-_\.]', '', value)
    return value

def build_ups_data_response(data):
    device_fields = {
        'model': get_supported_value(data, 'device_model'),
        'manufacturer': get_supported_value(data, 'device_mfr'),
        'serial': get_supported_value(data, 'device_serial'),
        'type': get_supported_value(data, 'device_type'),
        'location': get_supported_value(data, 'device_location')
    }
    try:
        load = float(get_supported_value(data, 'ups_load', '0'))
        nominal_power = float(get_supported_value(data, 'ups_realpower_nominal', '960'))
        calculated_power = (load * nominal_power) / 100
        power_value = str(round(calculated_power, 2))
    except (ValueError, TypeError):
        power_value = '0'
    return {
        'device': device_fields,
        'ups': {
            'status': get_supported_value(data, 'ups_status'),
            'load': get_supported_value(data, 'ups_load', '0'),
            'temperature': get_supported_value(data, 'ups_temperature', '0'),
            'power': power_value,
            'realpower': power_value,
            'realpower_nominal': get_supported_value(data, 'ups_realpower_nominal', '960')
        },
        'input': {
            'voltage': get_supported_value(data, 'input_voltage', '0'),
            'frequency': get_supported_value(data, 'input_frequency', '0'),
            'voltage_nominal': get_supported_value(data, 'input_voltage_nominal', '0'),
            'current': get_supported_value(data, 'input_current', '0')
        },
        'output': {
            'voltage': get_supported_value(data, 'output_voltage', '0'),
            'frequency': get_supported_value(data, 'output_frequency', '0'),
            'current': get_supported_value(data, 'output_current', '0')
        },
        'battery': {
            'charge': get_supported_value(data, 'battery_charge', '0'),
            'runtime': get_supported_value(data, 'battery_runtime', '0'),
            'voltage': get_supported_value(data, 'battery_voltage', '0'),
            'temperature': get_supported_value(data, 'battery_temperature', 'N/A'),
            'type': get_supported_value(data, 'battery_type', 'N/A')
        },
        'ambient': {
            'temperature': get_supported_value(data, 'ambient_temperature', 'N/A'),
            'humidity': get_supported_value(data, 'ambient_humidity', 'N/A')
        }
    }

def format_chart_data(data, field):
    formatted_data = []
    for entry in data:
        try:
            if field in entry and entry[field] is not None:
                formatted_data.append({
                    'x': entry['timestamp'],
                    'y': float(entry[field]) if isinstance(entry[field], (int, float, str)) else 0
                })
        except (KeyError, ValueError, TypeError) as e:
            logger.debug(f"Skipping data point for {field}: {e}")
            continue
    return formatted_data

# Add SETTINGS_DIR
SETTINGS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'instance', 'settings')

def register_api_routes(app, layouts_file='layouts.json'):
    """Registers all API routes"""
    
    def jsonify_pretty(*args, **kwargs):
        response = jsonify(*args, **kwargs)
        response.set_data(json.dumps(response.get_json(), indent=2))
        return response

    @app.route('/api/data/<column>')
    def get_column_data(column):
        """Returns the value of a specific column"""
        try:
            logger.debug(f"Requesting column: {column}")
            
            # Get the configured timezone
            tz = get_configured_timezone()
            current_time = datetime.now(tz)

            # Special handling for ups_realpower_days
            if column == 'ups_realpower_days':
                UPSDynamicData = get_ups_model()
                # Query to find the last non-null and non-zero value
                last_value = UPSDynamicData.query\
                    .filter(UPSDynamicData.ups_realpower_days.isnot(None))\
                    .filter(UPSDynamicData.ups_realpower_days != 0)\
                    .order_by(UPSDynamicData.timestamp_tz.desc())\
                    .first()
                
                if last_value:
                    value = getattr(last_value, column)
                    timestamp = format_datetime_tz(last_value.timestamp_tz).isoformat()
                    return jsonify({
                        'success': True,
                        'data': {
                            column: float(value),
                            'timestamp': timestamp
                        }
                    })

            # If the requested column is timestamp, return the current timestamp
            if column == 'timestamp':
                return jsonify({
                    'success': True,
                    'data': {
                        'timestamp': current_time.isoformat(),
                        column: current_time.isoformat()
                    }
                })

            # First check in dynamic data
            UPSDynamicData = get_ups_model()
            dynamic_data = UPSDynamicData.query.order_by(UPSDynamicData.timestamp_tz.desc()).first()
            
            if dynamic_data and hasattr(dynamic_data, column):
                value = getattr(dynamic_data, column)
                if value is not None:
                    # Format the value based on type
                    if isinstance(value, datetime):
                        value = format_datetime_tz(value).isoformat()
                    elif isinstance(value, (float, int)):
                        value = float(value) if isinstance(value, float) else int(value)
                    else:
                        value = str(value)

                    # Ensure the timestamp is in the correct timezone
                    timestamp = format_datetime_tz(dynamic_data.timestamp_tz).isoformat()
                    
                    return jsonify({
                        'success': True,
                        'data': {
                            column: value,
                            'timestamp': timestamp
                        }
                    })

            # If not found in dynamic data, check in static data
            UPSStaticData = create_static_model()
            static_data = UPSStaticData.query.first()
            
            if static_data and hasattr(static_data, column):
                value = getattr(static_data, column)
                if value is not None:
                    # Format the value based on type
                    if isinstance(value, datetime):
                        value = format_datetime_tz(value).isoformat()
                    elif isinstance(value, (float, int)):
                        value = float(value) if isinstance(value, float) else int(value)
                    else:
                        value = str(value)

                    # Use the timestamp of the static data if available, otherwise use the current timestamp
                    timestamp = (format_datetime_tz(static_data.timestamp_tz) if hasattr(static_data, 'timestamp_tz') 
                               else current_time).isoformat()
                    
                    return jsonify({
                        'success': True,
                        'data': {
                            column: value,
                            'timestamp': timestamp
                        }
                    })
            
            # Special handling for ups_realpower_hrs
            if column == 'ups_realpower_hrs' and dynamic_data:
                value = get_realpower_hrs(dynamic_data)
                timestamp = format_datetime_tz(dynamic_data.timestamp_tz).isoformat()
                return jsonify({
                    'success': True,
                    'data': {
                        column: value,
                        'timestamp': timestamp
                    }
                })
            
            # If the column is not found, return 404
            logger.warning(f"Column {column} not found in either dynamic or static data")
            return jsonify({
                'success': False,
                'error': f'Column {column} not found or has no value',
                'data': {
                    column: None,
                    'timestamp': current_time.isoformat()
                }
            }), 404
            
        except Exception as e:
            logger.error(f"Error getting column {column}: {str(e)}", exc_info=True)
            return jsonify({
                'success': False,
                'error': str(e),
                'data': {
                    column: None,
                    'timestamp': datetime.now(get_configured_timezone()).isoformat()
                }
            }), 500

    @app.route('/api/data/all')
    def api_data_all():
        try:
            data = get_ups_data()
            
            # Add UPS_REALPOWER_NOMINAL from settings
            from core.settings import UPS_REALPOWER_NOMINAL
            
            # Convert the data object to a dictionary
            data_dict = {}
            for key in dir(data):
                if not key.startswith('_') and not callable(getattr(data, key)):
                    data_dict[key] = getattr(data, key)
            
            # Add the UPS_REALPOWER_NOMINAL value
            data_dict['UPS_REALPOWER_NOMINAL'] = UPS_REALPOWER_NOMINAL
            
            return jsonify({
                'success': True,
                'data': data_dict
            })
        except Exception as e:
            logger.error(f"Error in api_data_all: {str(e)}")
            return jsonify({
                'success': False,
                'message': str(e)
            })

    @app.route('/api/database-info')
    def database_info():
        """Returns information about the database tables"""
        try:
            UPSStaticData = create_static_model()
            UPSDynamicData = get_ups_model()
            tz = get_configured_timezone()
            
            response_data = {
                'success': True,
                'timestamp': datetime.now(tz).isoformat(),
                'tables': {}
            }
            
            # Static table information
            try:
                static_count = UPSStaticData.query.count()
                static_info = {
                    'name': UPSStaticData.__tablename__,
                    'columns': [],
                    'record_count': static_count
                }
                
                for column in UPSStaticData.__table__.columns:
                    static_info['columns'].append({
                        'name': column.name,
                        'type': str(column.type)
                    })
                
                response_data['tables']['static'] = static_info
            except Exception as e:
                logger.error(f"Error getting static table info: {str(e)}")
                response_data['tables']['static'] = {'error': str(e)}
            
            # Dynamic table information
            try:
                dynamic_count = UPSDynamicData.query.count()
                dynamic_info = {
                    'name': UPSDynamicData.__tablename__,
                    'columns': [],
                    'record_count': dynamic_count
                }
                
                for column in UPSDynamicData.__table__.columns:
                    dynamic_info['columns'].append({
                        'name': column.name,
                        'type': str(column.type)
                    })
                
                response_data['tables']['dynamic'] = dynamic_info
            except Exception as e:
                logger.error(f"Error getting dynamic table info: {str(e)}")
                response_data['tables']['dynamic'] = {'error': str(e)}
            
            return jsonify(response_data)
            
        except Exception as e:
            logger.error(f"Error in database info: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e),
                'timestamp': datetime.now(get_configured_timezone()).isoformat()
            }), 500

    @app.route('/health')
    def health_check():
        """ Checks the system status"""
        try:
            UPSDynamicData = get_ups_model()
            tz = get_configured_timezone()
            current_time = datetime.now(tz)
            
            last_record = UPSDynamicData.query.order_by(UPSDynamicData.timestamp_tz.desc()).first()
            
            status = {
                'success': True,
                'timestamp': current_time.isoformat(),
                'database': {
                    'status': True if last_record else False,
                    'last_update': last_record.timestamp_tz.isoformat() if last_record else None,
                    'record_count': UPSDynamicData.query.count()
                }
            }
            
            # Check NUT service
            try:
                data = get_ups_data()
                status['nut_service'] = {
                    'status': True if data else False,
                    'ups_status': getattr(data, 'ups_status', 'unknown') if data else 'unknown',
                    'model': getattr(data, 'device_model', 'unknown') if data else 'unknown'
                }
            except Exception as e:
                status['nut_service'] = {
                    'status': False,
                    'error': str(e)
                }
            
            return jsonify(status)
            
        except Exception as e:
            logger.error(f"Health check failed: {str(e)}", exc_info=True)
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/table/dynamic')
    def get_dynamic_table():
        """Returns the dynamic table data"""
        try:
            rows = request.args.get('rows', 'all')
            UPSDynamicData = get_ups_model()
            tz = get_configured_timezone()
            
            query = UPSDynamicData.query.order_by(UPSDynamicData.timestamp_tz.desc())
            
            if rows != 'all':
                try:
                    query = query.limit(int(rows))
                except ValueError:
                    query = query.limit(60)
                    
            data = query.all()
            
            if not data:
                return jsonify({
                    'success': True,
                    'columns': [],
                    'rows': []
                })
            
            columns = [column.name for column in UPSDynamicData.__table__.columns]
            
            rows_data = []
            for row in data:
                item = {}
                for column in columns:
                    try:
                        value = getattr(row, column)
                        if value is None:
                            item[column] = None
                        elif isinstance(value, datetime):
                            value = format_datetime_tz(value)
                            item[column] = value.isoformat()
                        elif isinstance(value, (int, float)):
                            item[column] = float(value) if isinstance(value, float) else int(value)
                        else:
                            item[column] = str(value)
                    except Exception as e:
                        logger.error(f"Error processing column {column}: {str(e)}")
                        item[column] = None
                rows_data.append(item)
                
            logger.debug(f"Returning {len(rows_data)} rows with columns: {columns}")
            
            return jsonify({
                'success': True,
                'columns': columns,
                'rows': rows_data
            })
            
        except Exception as e:
            logger.error(f"Error getting dynamic table: {str(e)}", exc_info=True)
            return jsonify({
                'success': False,
                'error': str(e),
                'columns': [],
                'rows': []
            }), 500

    @app.route('/api/table/static')
    def get_static_table():
        """Returns the static table data"""
        try:
            UPSStaticData = create_static_model()
            data = UPSStaticData.query.first()
            
            if not data:
                return jsonify({
                    'success': True,
                    'columns': [],
                    'rows': []
                })
                
            # Get the columns
            columns = [column.name for column in UPSStaticData.__table__.columns]
            
            # Prepare the data for the response
            row_data = {}
            for column in columns:
                value = getattr(data, column)
                if isinstance(value, datetime):
                    value = value.isoformat()
                row_data[column] = value
                
            return jsonify({
                'success': True,
                'columns': columns,
                'rows': [row_data]
            })
            
        except Exception as e:
            logger.error(f"Error getting static table: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/nut_event', methods=['POST'])
    def nut_event():
        """Handles NUT events"""
        try:
            if not request.is_json:
                logger.error("No JSON data received")
                return jsonify({"status": "error", "message": "No JSON data received"}), 400
            
            data = request.get_json()
            return handle_nut_event(app, data)
            
        except Exception as e:
            logger.error(f"Error: {str(e)}", exc_info=True)
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/api/nut_history')
    def nut_history():
        """Returns the NUT event history"""
        try:
            return get_event_history(app)
        except Exception as e:
            logger.error(f"Error getting NUT history: {str(e)}")
            return jsonify([]), 200  # Returns an empty list in case of error

    @app.route('/api/table/events', methods=['GET', 'POST'])
    def get_events_table_route():
        """API to get and manage events"""
        if request.method == 'GET':
            try:
                rows = request.args.get('rows', 'all')
                table_data = get_events_table(rows)
                return jsonify(table_data)
            except Exception as e:
                logger.error(f"Error getting events: {str(e)}", exc_info=True)
                return jsonify({'error': str(e)}), 500

        elif request.method == 'POST':
            try:
                event_id = request.json.get('event_id')
                success, message = acknowledge_event(event_id)
                if success:
                    return jsonify({"status": "ok"})
                return jsonify({"status": "error", "message": message}), 404
            except Exception as e:
                logger.error(f"Error acknowledging event: {str(e)}", exc_info=True)
                return jsonify({'status': 'error', 'message': str(e)}), 500

    @app.route('/api/settings/mail', methods=['GET'])
    def get_mail_config():
        """Retrieves the current email configuration"""
        try:
            logger.debug("Fetching mail config...")
            config = MailConfig.query.get(1)
            logger.debug(f"Found config: {config}")
            
            if not config:
                logger.info("No mail config found, creating default...")
                config = MailConfig(
                    smtp_server='',
                    smtp_port='',
                    from_name='',
                    from_email='',
                    username='',
                    enabled=False,
                    provider='',
                    tls=True,
                    tls_starttls=True
                )
                db.session.add(config)
                try:
                    db.session.commit()
                    logger.info("Default mail config created successfully")
                except Exception as e:
                    logger.error(f"Error creating default config: {str(e)}")
                    db.session.rollback()
                    raise
            
            return jsonify({
                'success': True,
                'data': {
                    'smtp_server': config.smtp_server or '',
                    'smtp_port': config.smtp_port or '',
                    'from_name': config.from_name or '',
                    'from_email': config.from_email or '',
                    'username': config.username or '',
                    'enabled': bool(config.enabled),
                    'provider': config.provider or '',
                    'tls': bool(config.tls),
                    'tls_starttls': bool(config.tls_starttls),
                    'last_test_date': config.last_test_date.isoformat() if config.last_test_date else None,
                    'last_test_status': config.last_test_status or ''
                }
            })
        except Exception as e:
            logger.error(f"Error getting mail config: {str(e)}", exc_info=True)
            return jsonify({'success': False, 'error': str(e)}), 500

    @app.route('/api/settings/mail/test', methods=['POST'])
    def test_mail_config():
        """Tests the email configuration"""
        try:
            config_data = request.get_json()
            success, message = test_email_config(config_data)
            return jsonify({
                'success': success,
                'message': message
            })
        except Exception as e:
            logger.error(f"Error testing mail config: {str(e)}")
            return jsonify({'success': False, 'error': str(e)}), 500

    @app.route('/api/settings/mail', methods=['POST'])
    def save_mail_settings():
        """Saves the email configuration"""
        try:
            config_data = request.get_json()
            success, error = save_mail_config(config_data)
            if success:
                return jsonify({'success': True})
            return jsonify({'success': False, 'error': error}), 400
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)}), 500

    @app.route('/api/settings/nutify', methods=['GET'])
    def get_nutify_settings():
        """Retrieves the notification settings"""
        try:
            settings = NotificationSettings.query.all()
            return jsonify({
                'success': True,
                'data': [{
                    'id': s.id,
                    'event_type': s.event_type,
                    'enabled': s.enabled
                } for s in settings]
            })
        except Exception as e:
            logger.error(f"Error getting nutify settings: {str(e)}", exc_info=True)
            return jsonify({'success': False, 'error': str(e)}), 500

    @app.route('/api/settings/nutify', methods=['POST'])
    def update_nutify_settings():
        """Updates the notification settings"""
        try:
            data = request.json
            with data_lock:  # Add the lock for security
                for setting in data:
                    nutify = NotificationSettings.query.filter_by(event_type=setting['event_type']).first()
                    if nutify:
                        nutify.enabled = setting['enabled']
                        nutify.updated_at = datetime.utcnow()
                    else:
                        # If the setting does not exist, create it
                        new_setting = NotificationSettings(
                            event_type=setting['event_type'],
                            enabled=setting['enabled']
                        )
                        db.session.add(new_setting)
                db.session.commit()
            
            # Log for debug
            logger.info(f"Updated notification settings: {data}")
            
            return jsonify({
                'success': True,
                'message': 'Notification settings updated successfully'
            })
        except Exception as e:
            db.session.rollback()
            logger.error(f"Error updating notification settings: {str(e)}", exc_info=True)
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/settings/nutify/single', methods=['POST'])
    def update_single_nutify_setting():
        """Updates a single notification setting"""
        try:
            data = request.json
            if not data or 'event_type' not in data or 'enabled' not in data:
                return jsonify({
                    'success': False,
                    'error': 'Missing required fields: event_type and enabled'
                }), 400
                
            event_type = data['event_type']
            enabled = data['enabled']
            
            with data_lock:  # Use the lock for security
                nutify = NotificationSettings.query.filter_by(event_type=event_type).first()
                if nutify:
                    nutify.enabled = enabled
                    nutify.updated_at = datetime.utcnow()
                else:
                    # If the setting does not exist, create it
                    new_setting = NotificationSettings(
                        event_type=event_type,
                        enabled=enabled
                    )
                    db.session.add(new_setting)
                db.session.commit()
            
            # Log for debug
            logger.info(f"Updated single notification setting: {event_type} -> {enabled}")
            
            return jsonify({
                'success': True,
                'message': f'Notification setting for {event_type} updated successfully'
            })
        except Exception as e:
            db.session.rollback()
            logger.error(f"Error updating single notification setting: {str(e)}", exc_info=True)
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    @app.route('/api/settings/variables', methods=['GET'])
    def get_variables_settings():
        try:
            config = VariableConfig.query.first()
            if config:
                return jsonify({
                    'success': True,
                    'data': {
                        'currency': config.currency,
                        'price_per_kwh': config.price_per_kwh,
                        'co2_factor': config.co2_factor
                    }
                })
            return jsonify({'success': True, 'data': {}})
        except Exception as e:
            logger.error(f"Error getting variables config: {str(e)}")
            return jsonify({'success': False, 'error': str(e)})

    @app.route('/api/settings/variables', methods=['POST'])
    def save_variables_config():
        """Saves the variables configuration"""
        try:
            data = request.get_json()
            if not data:
                return jsonify({'success': False, 'error': 'No data provided'}), 400

            config = VariableConfig.query.first()
            if not config:
                config = VariableConfig()
                db.session.add(config)

            # Update the fields
            if 'currency' in data:
                config.currency = data['currency']
            if 'price_per_kwh' in data:
                config.price_per_kwh = data['price_per_kwh']
            if 'co2_factor' in data:
                config.co2_factor = data['co2_factor']

            db.session.commit()
            
            return jsonify({
                'success': True,
                'message': 'Variables configuration saved successfully'
            })
        except Exception as e:
            db.session.rollback()
            logger.error(f"Error saving variables config: {str(e)}")
            return jsonify({'success': False, 'error': str(e)}), 500

    @app.route('/api/events/acknowledge/<int:event_id>', methods=['POST'])
    def acknowledge_event_route(event_id):
        """Acknowledges an event"""
        try:
            with data_lock:
                event = db.session.get(UPSEvent, event_id)
                if event:
                    event.acknowledged = True
                    db.session.commit()
                    return jsonify({'success': True, 'message': 'Event acknowledged successfully'})
                return jsonify({'success': False, 'message': 'Event not found'}), 404
        except Exception as e:
            logger.error(f"Error acknowledging event: {str(e)}")
            return jsonify({'success': False, 'message': str(e)}), 500

    @app.route('/api/events/delete/<int:event_id>', methods=['DELETE'])
    def delete_event_route(event_id):
        """Deletes an event from the database"""
        try:
            with data_lock:
                event = db.session.get(UPSEvent, event_id)
                if event:
                    db.session.delete(event)
                    db.session.commit()
                    return jsonify({'success': True, 'message': 'Event deleted successfully'})
                return jsonify({'success': False, 'message': 'Event not found'}), 404
        except Exception as e:
            logger.error(f"Error deleting event: {str(e)}")
            return jsonify({'success': False, 'message': str(e)}), 500

    @app.route('/api/events/acknowledge/bulk', methods=['POST'])
    def acknowledge_events_bulk():
        """Acknowledges multiple events"""
        try:
            data = request.get_json()
            event_ids = data.get('event_ids', [])
            
            if not event_ids:
                return jsonify({'success': False, 'message': 'No events specified'}), 400
                
            with data_lock:
                events = UPSEvent.query.filter(UPSEvent.id.in_(event_ids)).all()
                for event in events:
                    event.acknowledged = True
                db.session.commit()
                return jsonify({'success': True, 'message': f'{len(events)} events acknowledged successfully'})
        except Exception as e:
            logger.error(f"Error acknowledging events in bulk: {str(e)}")
            return jsonify({'success': False, 'message': str(e)}), 500

    @app.route('/api/events/delete/bulk', methods=['DELETE'])
    def delete_events_bulk():
        """Deletes multiple events from the database"""
        try:
            data = request.get_json()
            event_ids = data.get('event_ids', [])
            
            if not event_ids:
                return jsonify({'success': False, 'message': 'No events specified'}), 400
                
            with data_lock:
                events = UPSEvent.query.filter(UPSEvent.id.in_(event_ids)).all()
                for event in events:
                    db.session.delete(event)
                db.session.commit()
                return jsonify({'success': True, 'message': f'{len(events)} events deleted successfully'})
        except Exception as e:
            logger.error(f"Error deleting events in bulk: {str(e)}")
            return jsonify({'success': False, 'message': str(e)}), 500

    @app.route('/api/settings/<filename>', methods=['POST'])
    def save_settings(filename):
        """Saves the settings in a JSON file"""
        if not filename.endswith('.json'):
            return jsonify({'error': 'Invalid file type. Only JSON files are allowed'}), 400

        try:
            file_path = os.path.join(SETTINGS_DIR, filename)
            if not os.path.realpath(file_path).startswith(os.path.realpath(SETTINGS_DIR)):
                return jsonify({'error': 'Invalid file path'}), 400

            try:
                with open(file_path, 'r') as f:
                    existing_data = json.load(f)
            except FileNotFoundError:
                existing_data = {}

            new_data = request.get_json()
            if new_data is None:
                return jsonify({'error': 'No JSON data provided'}), 400

            existing_data.update(new_data)
            os.makedirs(SETTINGS_DIR, exist_ok=True)
            
            with open(file_path, 'w') as f:
                json.dump(existing_data, f, indent=4)
            
            return jsonify({'status': 'success'})
        except Exception as e:
            return jsonify({'status': 'error', 'message': str(e)}), 500

    @app.route('/api/restart', methods=['POST'])
    def restart_application():
        """
        Restart the application.
        Note: This endpoint works only in development mode.
        """
        import sys, os
        try:
            logger.info("Restarting application...")
            # The following will replace the current process with a new one.
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            return jsonify(success=False, message=str(e)), 500

    @app.route('/api/logs/clear', methods=['POST'])
    def clear_logs_api():
        """
        Clear log files for the specified log type.
        Query parameters:
          - type: log type (default 'all')
        """
        from core.options import clear_logs
        log_type = request.args.get('type', 'all')
        success, message = clear_logs(log_type)
        return jsonify(success=success, message=message)

    @app.route('/api/ups/cache')
    def get_ups_cache():
        """
        Endpoint to return the UPS data corresponding to the current second.
        If an exact record for this second is not found, the last record present is returned.
        """
        try:
            tz = get_configured_timezone()
            now = datetime.now(tz).replace(microsecond=0)
            
            data_list = ups_data_cache.data
            if not data_list:
                return jsonify({
                    'success': True,
                    'data': None
                })
            
            # The data in cache is already in TZ, so we compare directly
            matching = [
                entry for entry in data_list
                if 'timestamp' in entry and parser.parse(entry['timestamp']).replace(microsecond=0) == now
            ]
            
            result = matching[-1] if matching else data_list[-1]
            
            # Use json.dumps with our encoder instead of jsonify
            return current_app.response_class(
                json.dumps({
                    'success': True,
                    'data': result
                }, cls=CustomJSONEncoder),
                mimetype='application/json'
            )
        
        except Exception as e:
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500

    def get_current_email_settings():
        """Get configured email from mail settings"""
        try:
            mail_config = MailConfig.query.first()
            if mail_config and mail_config.enabled:
                # Return the destination email, not the sender's email
                return mail_config.to_email if hasattr(mail_config, 'to_email') else mail_config.from_email
            return None
        except Exception as e:
            logger.error(f"Error getting email settings: {str(e)}")
            return None

    @app.route('/api/settings/log', methods=['GET', 'POST'])
    def update_log_setting():
        """Update and retrieve log settings"""
        if request.method == 'GET':
            # Add log for debug
            logger.debug(f"Reading settings - RAW values: LOG={LOG!r}, LOG_LEVEL={LOG_LEVEL!r}, LOG_WERKZEUG={LOG_WERKZEUG!r}")
            log_enabled = str(LOG).strip().lower() == 'true'
            werkzeug_enabled = str(LOG_WERKZEUG).strip().lower() == 'true'
            logger.debug(f"Processed values: log_enabled={log_enabled}, level={LOG_LEVEL}, werkzeug={werkzeug_enabled}")
            
            return jsonify({
                'success': True,
                'data': {
                    'log': log_enabled,
                    'level': LOG_LEVEL,
                    'werkzeug': werkzeug_enabled
                }
            })

        data = request.get_json()
        # If the data is empty or does not contain 'log', return the current state instead of an error
        if not data or len(data) == 0 or 'log' not in data:
            # Return the same response format as the GET method
            log_enabled = str(LOG).strip().lower() == 'true'
            werkzeug_enabled = str(LOG_WERKZEUG).strip().lower() == 'true'
            logger.debug(f"POST with empty data - Returning current settings: log={log_enabled}, level={LOG_LEVEL}, werkzeug={werkzeug_enabled}")
            
            return jsonify({
                'success': True,
                'data': {
                    'log': log_enabled,
                    'level': LOG_LEVEL,
                    'werkzeug': werkzeug_enabled
                }
            })
        
        # Normalize 'log'
        new_value = str(data['log']).lower()
        if new_value not in ['true', 'false']:
            return jsonify(success=False, message="Invalid value for 'log' (must be true or false)"), 400
        
        # Optional: Normalize log level (handled below)
        
        # Normalize 'werkzeug'
        new_werkzeug = None
        if 'werkzeug' in data:
            new_werkzeug = str(data['werkzeug']).lower()
            if new_werkzeug not in ['true', 'false']:
                return jsonify(success=False, message="Invalid value for 'werkzeug' (must be true or false)"), 400
        
        new_level = None
        if 'level' in data:
            new_level = str(data['level']).upper()
            if new_level not in ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']:
                return jsonify(success=False, message="Invalid log level (must be DEBUG, INFO, WARNING, ERROR, or CRITICAL)"), 400

        try:
            settings_path = os.path.join(current_app.root_path, 'config', 'settings.txt')
            with open(settings_path, 'r') as f:
                lines = f.readlines()
            new_lines = []
            pattern_log = r"^LOG\s*="
            pattern_level = r"^LOG_LEVEL\s*="
            pattern_werkzeug = r"^LOG_WERKZEUG\s*="
            updated_log = False
            updated_level = False
            updated_werkzeug = False
            for line in lines:
                if re.match(pattern_log, line):
                    new_lines.append(f"LOG = {new_value}\n")
                    updated_log = True
                elif new_level and re.match(pattern_level, line):
                    new_lines.append(f"LOG_LEVEL = {new_level}\n")
                    updated_level = True
                elif new_werkzeug and re.match(pattern_werkzeug, line):
                    new_lines.append(f"LOG_WERKZEUG = {new_werkzeug}\n")
                    updated_werkzeug = True
                else:
                    new_lines.append(line)
            if not updated_log:
                new_lines.append(f"LOG = {new_value}\n")
            if new_level and (not updated_level):
                new_lines.append(f"LOG_LEVEL = {new_level}\n")
            if new_werkzeug and (not updated_werkzeug):
                new_lines.append(f"LOG_WERKZEUG = {new_werkzeug}\n")
            with open(settings_path, 'w') as f:
                f.writelines(new_lines)
            return jsonify(success=True, message="Log setting updated. Please restart the application for changes to take effect."), 200
        except Exception as e:
            return jsonify(success=False, message=str(e)), 500

    @app.route('/api/logs/download', methods=['GET'])
    def download_logs():
        """
        Download filtered log files as a zip archive.
        Query parameters:
          - type: log type (default 'all')
          - level: log level (default 'all')
          - range: date range (default 'all')
        """
        from core.options import get_filtered_logs
        log_type = request.args.get('type', 'all')
        log_level = request.args.get('level', 'all')
        date_range = request.args.get('range', 'all')
        
        # Get the log file metadata (without content)
        logs_data = get_filtered_logs(
            log_type=log_type, 
            log_level=log_level, 
            date_range=date_range,
            return_metadata_only=True
        )
        
        if not logs_data or not logs_data['files']:
            return jsonify(success=False, message="No logs found"), 404
        
        import tempfile
        import zipfile
        
        tmp_zip = tempfile.NamedTemporaryFile(delete=False, suffix='.zip')
        with zipfile.ZipFile(tmp_zip, 'w') as zf:
            for log_file in logs_data['files']:
                file_path = log_file['path']
                try:
                    # Read the file content and filter by level if necessary
                    with open(file_path, 'r') as f:
                        content = f.read()
                        
                    # Filter by log level if specified
                    if log_level != 'all':
                        filtered_lines = []
                        for line in content.splitlines():
                            if re.search(f"\\b{log_level.upper()}\\b", line, re.I):
                                filtered_lines.append(line)
                        content = '\n'.join(filtered_lines)
                    
                    zf.writestr(log_file['name'], content)
                except Exception as e:
                    logger.error(f"Error adding log file {file_path} to zip: {str(e)}")
                    continue
        
        tmp_zip.close()
        
        # Generate a file name with timestamp
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        download_name = f'logs_{timestamp}.zip'
        
        return send_file(tmp_zip.name,
                         mimetype='application/zip',
                         as_attachment=True,
                         download_name=download_name)

    @app.route('/api/upscmd/list')
    def get_ups_commands_api():
        """Returns the list of available commands for the UPS"""
        try:
            commands = get_ups_commands()
            return jsonify({
                'success': True,
                'commands': commands
            })
        except Exception as e:
            logger.error(f"Error getting UPS commands: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500
    
    @app.route('/api/upscmd/execute', methods=['POST'])
    def execute_ups_command_api():
        """Executes a command on the UPS"""
        try:
            command = request.json.get('command')
            if not command:
                return jsonify({
                    'success': False,
                    'error': 'No command specified'
                }), 400

            success, output = execute_command(command)
            return jsonify({
                'success': success,
                'output': output
            })
        except Exception as e:
            logger.error(f"Error executing UPS command: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            }), 500
    
    @app.route('/api/upscmd/clear/logs', methods=['POST'])
    def api_clear_command_logs():
        """API to clear the command logs"""
        try:
            with data_lock:
                # Delete all records from the correct table
                UPSCommand.query.delete()
                db.session.commit()
            return jsonify({'success': True})
        except Exception as e:
            logger.error(f"Error clearing command logs: {str(e)}")
            return jsonify({'success': False, 'error': str(e)})
    
    @app.route('/api/upsrw/list')
    def api_upsrw_list():
        """API to get the list of variables"""
        variables = get_ups_variables()
        return jsonify({
            'success': True,
            'variables': variables
        })
    
    @app.route('/api/upsrw/set', methods=['POST'])
    def api_upsrw_set():
        """API to set a variable"""
        data = request.get_json()
        name = data.get('name')
        value = data.get('value')
        
        if not name or value is None:
            return jsonify({
                'success': False,
                'error': 'Name and value are required'
            })
        
        success, message = set_ups_variable(name, value)
        return jsonify({
            'success': success,
            'message': message
        })
    
    @app.route('/api/upsrw/history')
    def api_upsrw_history():
        """API to get the variable history"""
        try:
            history = get_variable_history()
            return jsonify({
                'success': True,
                'history': history
            })
        except Exception as e:
            logger.error(f"Error getting variable history: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            })
            
    @app.route('/api/upsrw/history/<variable>')
    def api_upsrw_history_variable(variable):
        """API to get the history of a specific variable"""
        try:
            history = get_variable_history(variable)
            return jsonify({
                'success': True,
                'history': history
            })
        except Exception as e:
            logger.error(f"Error getting variable history: {variable} {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            })
        
    @app.route('/api/upsrw/clear-history', methods=['POST'])
    def api_upsrw_clear_history():
        """API to clear the history"""
        try:
            success = clear_variable_history()
            return jsonify({
                'success': success
            })
        except Exception as e:
            logger.error(f"Error clearing history: {str(e)}")
            return jsonify({
                'success': False,
                'error': str(e)
            })

    return app 

def format_datetime(dt):
    """
    Format the datetime object using the timezone configured in config.txt.
    If dt is naive, assume it is in UTC and then convert it.
    """
    tz_str = get_configured_timezone()
    timezone = pytz.timezone(tz_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=pytz.utc)
    dt = dt.astimezone(timezone)
    return dt.isoformat() 

def ensure_timezone(dt):
    """Ensure datetime has the configured timezone"""
    if dt is None:
        return None
    tz = get_configured_timezone()
    if dt.tzinfo is None:
        return tz.localize(dt)
    return dt.astimezone(tz) 

def debug_value(value):
    """Helper function to debug values"""
    if value is None:
        return "None"
    return f"{type(value).__name__}: {str(value)}"

def log_query_result(data, source):
    """Helper function to log the results of queries"""
    if data is None:
        logger.debug(f"{source} query returned None")
        return
    
    logger.debug(f"{source} query returned data with columns: {[c.name for c in data.__table__.columns]}")
    for column in data.__table__.columns:
        value = getattr(data, column.name, None)
        logger.debug(f"Column {column.name}: {debug_value(value)}") 

def format_datetime_tz(dt):
    """Format datetime with timezone"""
    if dt is None:
        return None
    tz = get_configured_timezone()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt

def get_realpower_hrs(dynamic_data):
    """Helper function to calculate ups_realpower_hrs if not present"""
    try:
        # First try to get the value directly
        if hasattr(dynamic_data, 'ups_realpower_hrs'):
            value = getattr(dynamic_data, 'ups_realpower_hrs')
            if value is not None:
                return float(value)
        
        # If not available, calculate from realpower and load
        realpower = getattr(dynamic_data, 'ups_realpower_nominal', None)
        load = getattr(dynamic_data, 'ups_load', None)
        
        if realpower is not None and load is not None:
            try:
                realpower = float(realpower)
                load = float(load)
                return (realpower * load) / 100.0
            except (ValueError, TypeError):
                logger.error("Error converting realpower or load to float")
                return 0.0
                
        logger.warning("Missing required attributes for ups_realpower_hrs calculation")
        return 0.0
        
    except Exception as e:
        logger.error(f"Error in get_realpower_hrs: {str(e)}")
        return 0.0 