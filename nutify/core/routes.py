from flask import render_template, jsonify, request, send_file
from flask_socketio import emit
from .db_module import (
    get_ups_data, 
    get_ups_model, 
    create_static_model,
    data_lock, 
    db
)
from .upsmon_client import handle_nut_event, get_event_history, get_events_table, acknowledge_event
from .upscmd import get_ups_commands, execute_command, get_command_stats
import datetime
import json
import os
import logging
from datetime import datetime
import configparser
import pytz
from .energy import register_routes as register_energy_routes
from .battery import register_routes as register_battery_routes
from .mail import (
    MailConfig, test_email_config, save_mail_config,
    init_notification_settings, get_notification_settings
)
from .upsrw import get_variable_history, clear_variable_history
from .voltage import get_available_voltage_metrics, get_voltage_stats, get_voltage_history
from .ups_socket import UPSSocketServer
import atexit
from .power import register_routes as register_power_routes
from .voltage import register_routes as register_voltage_routes
from core.options import (
    get_database_stats, get_log_files, get_system_info,
    get_filtered_logs, optimize_database, vacuum_database, backup_database, clear_logs
)
from core.logger import web_logger as logger
from core.settings import LOG, LOG_LEVEL, LOG_WERKZEUG, get_configured_timezone
import base64
logger.info("📡 Initializing routes")

def register_routes(app):
    """Registers all web routes for the application"""
    
    # Initialize the socket server
    socket_server = UPSSocketServer(app)
    socket_server.start()
    
    # Register cleanup function at exit
    @atexit.register
    def cleanup():
        socket_server.stop()
    
    register_energy_routes(app)
    register_battery_routes(app)
    register_power_routes(app)
    register_voltage_routes(app)
    
    @app.route('/')
    @app.route('/index')
    def index():
        """Render the main page"""
        data = get_ups_data()
        return render_template('dashboard/main.html', 
                             data=data,
                             timezone=get_configured_timezone())

    @app.route('/upscmd')
    def upscmd_page():
        """Page for managing UPS commands"""
        data = get_ups_data()
        return render_template('dashboard/upscmd.html', title='UPS Commands', data=data)

    @app.route('/events')
    def events_page():
        """Events page route"""
        data = get_ups_data()  # This takes the static UPS data
        return render_template('dashboard/events.html', 
                             data=data,
                             timezone=get_configured_timezone())

    @app.route('/options')
    @app.route('/settings')
    def options():
        """Render the options page"""
        data = get_ups_data()
        notify_settings = get_notification_settings()
        mail_config = MailConfig.query.first()
        
        # Read values from settings.txt; if LOG is not bool, normalize the comparison:
        log_enabled = str(LOG).strip().lower() == 'true'
        werkzeug_log_enabled = str(LOG_WERKZEUG).strip().lower() == 'true'
        
        # Debug logs for log settings
        logger.debug(f"DEBUG OPTIONS: LOG = {LOG!r}, log_enabled = {log_enabled}")
        logger.debug(f"DEBUG OPTIONS: LOG_WERKZEUG = {LOG_WERKZEUG!r}, werkzeug_log_enabled = {werkzeug_log_enabled}")
        
        return render_template('dashboard/options.html',
                             data=data,
                             notify_settings=notify_settings,
                             mail_config=mail_config,
                             log_enabled=log_enabled,
                             log_level=LOG_LEVEL,
                             werkzeug_log_enabled=werkzeug_log_enabled,
                             timezone=get_configured_timezone())

    @app.route('/api')
    def api_page():
        """Render the API documentation"""
        try:
            data = get_ups_data()
            UPSStaticData = create_static_model()
            UPSDynamicData = get_ups_model()
            
            static_count = UPSStaticData.query.count()
            dynamic_count = UPSDynamicData.query.count()
            
            static_data = UPSStaticData.query.first()
            dynamic_data = UPSDynamicData.query.order_by(UPSDynamicData.timestamp_tz.desc()).first()
            
            schema = {
                'static': {
                    'name': UPSStaticData.__tablename__,
                    'record_count': static_count,
                    'columns': []
                },
                'dynamic': {
                    'name': UPSDynamicData.__tablename__,
                    'record_count': dynamic_count,
                    'columns': []
                }
            }
            
            if static_data:
                for column in UPSStaticData.__table__.columns:
                    value = getattr(static_data, column.name)
                    if isinstance(value, datetime):
                        value = value.isoformat()
                    schema['static']['columns'].append({
                        'name': column.name,
                        'type': str(column.type),
                        'current_value': value
                    })
            
            if dynamic_data:
                for column in UPSDynamicData.__table__.columns:
                    value = getattr(dynamic_data, column.name)
                    if isinstance(value, datetime):
                        value = value.isoformat()
                    schema['dynamic']['columns'].append({
                        'name': column.name,
                        'type': str(column.type),
                        'current_value': value
                    })
            
            return render_template('dashboard/api.html', 
                                 schema=schema,
                                 data=data,
                                 timezone=get_configured_timezone())
        except Exception as e:
            logger.error(f"Error rendering API page: {str(e)}", exc_info=True)
            return render_template('dashboard/api.html', 
                                 schema={},
                                 data={'device_model': 'UPS Monitor'},
                                 timezone=get_configured_timezone())

    @app.route('/upsrw')
    def upsrw_page():
        """Page for managing UPS variables"""
        try:
            # Get UPS data as per other pages
            data = get_ups_data()
            return render_template('dashboard/upsrw.html', 
                                 data=data,
                                 timezone=get_configured_timezone())
        except Exception as e:
            logger.error(f"Error rendering UPSrw page: {str(e)}", exc_info=True)
            # In case of error, pass at least the device_model
            return render_template('dashboard/upsrw.html', 
                                 data={'device_model': 'UPS Monitor'}, 
                                 timezone=get_configured_timezone())
        



    @app.route('/nut_event', methods=['POST'])
    def nut_event_route():
        """Handles incoming NUT events"""
        try:
            data = request.get_json()
            return handle_nut_event(app, data)
        except Exception as e:
            logger.error(f"Error handling NUT event: {str(e)}", exc_info=True)
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route('/ups_info')
    def ups_info_page():
        """Render the UPS static information page"""
        data = get_ups_data()
        return render_template('dashboard/ups_info.html', data=data)

    @app.route('/api/database/stats')
    def api_database_stats():
        """Return database statistics"""
        stats = get_database_stats()
        if stats is None:
            return jsonify({'success': False, 'error': 'Could not retrieve database statistics'}), 500
        return jsonify({'success': True, 'data': stats})

    @app.route('/api/logs/clear', methods=['POST'])
    def handle_clear_logs():
        """Handle log clearing API"""
        log_type = request.args.get('type', 'all')
        success, message = clear_logs(log_type)
        return jsonify({'success': success, 'message': message})

    @app.route('/api/logs', methods=['GET'])
    def handle_get_logs():
        """Handle log retrieval API"""
        log_type = request.args.get('type', 'all')
        log_level = request.args.get('level', 'all')
        date_range = request.args.get('range', 'all')
        
        # Pagination parameters
        try:
            page = int(request.args.get('page', '1'))
            page_size = int(request.args.get('page_size', '1000'))
            metadata_only = request.args.get('metadata_only', 'false').lower() == 'true'
        except ValueError:
            page = 1
            page_size = 1000
            metadata_only = False
        
        # Limit the page size to avoid memory issues
        page_size = min(page_size, 5000)
        
        logs = get_filtered_logs(
            log_type=log_type, 
            log_level=log_level, 
            date_range=date_range,
            page=page,
            page_size=page_size,
            return_metadata_only=metadata_only
        )
        
        return jsonify({'success': True, 'data': logs})

    @app.route('/api/system/info')
    def api_system_info():
        """Return system and project information"""
        info = get_system_info()
        if info is None:
            return jsonify({'success': False, 'error': 'Could not retrieve system info'}), 500
        return jsonify({'success': True, 'data': info})

    @app.route('/api/about/image')
    def get_about_image():
        """Return the base64 encoded about image"""
        try:
            image_path = os.path.join(app.static_folder, 'img', 'about_png')
            if not os.path.exists(image_path):
                return jsonify({'success': False, 'error': 'Image not found'}), 404

            # Read the base64 content and add MIME type prefix if needed
            with open(image_path, 'r') as f:
                content = f.read().strip()
                if not content.startswith('data:'):
                    content = 'data:image/png;base64,' + content
                return jsonify({
                    'success': True,
                    'data': content
                })

        except Exception as e:
            logger.error(f"Error getting about image: {str(e)}")
            return jsonify({
                'success': False, 
                'error': f'Error getting about image: {str(e)}'
            }), 500

    @app.route('/api/database/optimize', methods=['POST'])
    def api_optimize_database():
        """Optimize database tables"""
        success = optimize_database()
        if success:
            return jsonify(success=True, message="Database optimized successfully")
        else:
            return jsonify(success=False, message="Error optimizing database"), 500

    @app.route('/api/database/vacuum', methods=['POST'])
    def api_vacuum_database():
        """Vacuum database to reclaim space"""
        success = vacuum_database()
        if success:
            return jsonify(success=True, message="Database vacuumed successfully")
        else:
            return jsonify(success=False, message="Error vacuuming database"), 500

    @app.route('/api/database/backup', methods=['GET'])
    def api_backup_database():
        """Create and download a backup of the database"""
        backup_path = backup_database()
        if backup_path:
            return send_file(backup_path,
                             mimetype="application/octet-stream",
                             as_attachment=True,
                             download_name=os.path.basename(backup_path))
        else:
            return jsonify(success=False, message="Error creating database backup"), 500

    return app