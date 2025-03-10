from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
import datetime
import logging
import os
import threading
import time
from flask_talisman import Talisman
import json
import eventlet
from collections import deque
from statistics import mean
import pytz
eventlet.monkey_patch()
import warnings

from core.db_module import (
    db, configure_ups, init_database, save_ups_data, get_ups_data, get_ups_model,
    UPSConnectionError, UPSCommandError, UPSDataError, create_static_model, data_lock
)
from core.routes import register_routes
from core.api import register_api_routes
from core.mail import init_notification_settings
from core.settings import (
    UPS_HOST, UPS_NAME, UPS_COMMAND, COMMAND_TIMEOUT,
    DEBUG_MODE, SERVER_PORT, SERVER_HOST,
    DB_NAME, LOG_LEVEL, LOG_FILE, LOG_FILE_ENABLED,
    LOG_FORMAT, LOG_LEVEL_DEBUG, LOG_LEVEL_INFO,
    TIMEZONE, INSTANCE_PATH, DB_URI, get_configured_timezone, LOG_WERKZEUG,
    SSL_ENABLED, SSL_CERT, SSL_KEY
)
from werkzeug.serving import WSGIRequestHandler
from core.socket_manager import socketio
from core.logger import system_logger as logger
from core.report import report_manager
from core.scheduler import scheduler, register_scheduler_routes

# Configuring logging
log_format = LOG_FORMAT
handlers = [logging.StreamHandler()]

if LOG_FILE_ENABLED:
    handlers.append(logging.FileHandler(LOG_FILE))

# Flask initialization
app = Flask(__name__, instance_path=INSTANCE_PATH)

# Flask configuration
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
app.config['SECRET_KEY'] = 'your_secret_key_here'
app.events_log = []

# Talisman configuration
Talisman(app, 
    force_https=SSL_ENABLED,
    content_security_policy=None
)

# Database configuration
app.config['INSTANCE_PATH'] = INSTANCE_PATH
app.config['SQLALCHEMY_DATABASE_URI'] = DB_URI
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['JSONIFY_PRETTYPRINT_REGULAR'] = True
app.config['JSON_SORT_KEYS'] = False
app.json.compact = False

# Components initialization
db.init_app(app)
socketio.init_app(app, 
    cors_allowed_origins="*",
    async_mode='eventlet'
)
register_routes(app)
register_api_routes(app, layouts_file='layouts.json')
register_scheduler_routes(app)

# Werkzeug log control
if isinstance(LOG_WERKZEUG, bool):
    use_werkzeug = LOG_WERKZEUG
else:
    use_werkzeug = LOG_WERKZEUG.lower() == 'true'

if not use_werkzeug:
    logging.getLogger('werkzeug').disabled = True

@app.template_filter('isoformat')
def isoformat_filter(value):
    """Converts a datetime object to ISO string with timezone"""
    tz = get_configured_timezone()
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            value = tz.localize(value)
        return value.astimezone(tz).isoformat()
    return value

# Data buffer
data_buffer = deque(maxlen=60)
buffer_lock = threading.Lock()

def polling_thread():
    """Thread for UPS data polling"""
    failures = 0
    last_save = time.time()
    
    while True:
        try:
            with app.app_context():
                success, error = save_ups_data()
                if not success:
                    failures += 1
                else:
                    failures = 0
                time.sleep(1)
                
        except (UPSConnectionError, UPSCommandError, UPSDataError) as e:
            failures += 1
            sleep_time = min(300, 2 ** failures)
            logger.warning(f"Polling error: {str(e)}. Backing off for {sleep_time}s")
            time.sleep(sleep_time)
        except Exception as e:
            logger.error(f"Unexpected error in polling thread: {str(e)}")
            failures += 1
            time.sleep(min(300, 2 ** failures))

# Disables Werkzeug log if LOG_LEVEL is OFF
if LOG_LEVEL == 'OFF':
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    WSGIRequestHandler.log = lambda *args, **kwargs: None

def init_app():
    """Initializes the application"""
    logger.info("💻 Initializing application...")
    try:
        configure_ups(host=UPS_HOST, name=UPS_NAME, 
                     command=UPS_COMMAND, timeout=COMMAND_TIMEOUT)
        
        with app.app_context():
            init_database(app)
            init_notification_settings()
            
            # Initialize scheduler with app
            logger.info("📋 Initializing Scheduler...")
            scheduler.init_app(app)
            
            # Verify schedulers loaded
            jobs = scheduler.get_scheduled_jobs()
            logger.info(f"Loaded {len(jobs)} scheduled jobs")
            
            # Start polling thread
            thread = threading.Thread(target=polling_thread, daemon=True)
            thread.start()
            
        logger.info("Application initialization complete")
    except Exception as e:
        logger.critical(f"Failed to initialize application: {str(e)}")
        raise


if __name__ == '__main__':
    warnings.filterwarnings("ignore", message="resource_tracker: There appear to be .* leaked semaphore objects to clean up at shutdown")
    init_app()
    
    # Configure SSL context if enabled
    ssl_context = None
    if SSL_ENABLED:
        if os.path.exists(SSL_CERT) and os.path.exists(SSL_KEY):
            logger.info(f"🔒 SSL enabled with certificate: {SSL_CERT}")
            ssl_context = (SSL_CERT, SSL_KEY)
            
            # Create a wsgi.py file for gunicorn
            wsgi_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wsgi.py')
            with open(wsgi_path, 'w') as f:
                f.write("""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import app, socketio, init_app

# Initialize the application when running with gunicorn
init_app()

if __name__ == '__main__':
    socketio.run(app)
""")
            
            # Start with gunicorn for SSL support
            import subprocess
            cmd = [
                "gunicorn", 
                "--worker-class", "eventlet", 
                "-w", "1", 
                "--certfile", SSL_CERT, 
                "--keyfile", SSL_KEY,
                "-b", f"{SERVER_HOST}:{SERVER_PORT}", 
                "wsgi:app"
            ]
            logger.info(f"Starting gunicorn with SSL: {' '.join(cmd)}")
            subprocess.Popen(cmd, cwd=os.path.dirname(os.path.abspath(__file__)))
            
            # Keep the main process running to handle signals
            import time
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                logger.info("Shutting down...")
                sys.exit(0)
        else:
            logger.warning(f"⚠️ SSL certificates not found at {SSL_CERT} and {SSL_KEY}. Running without SSL.")
            ssl_context = None
    
    # Only run socketio directly if not using SSL
    if not SSL_ENABLED or ssl_context is None:
        socketio.run(app, 
            debug=DEBUG_MODE, 
            host=SERVER_HOST, 
            port=SERVER_PORT,
            log_output=use_werkzeug,
            use_reloader=False
        )
