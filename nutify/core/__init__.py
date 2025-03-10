import os
import logging
from flask import Flask
from .db_module import (  
    db,                     # SQLAlchemy database instance
    UPSError,              # Base class for UPS errors
    UPSConnectionError,    # Connection error
    UPSCommandError,       # Command error
    UPSDataError,          # Data error
    init_database,         # Database initialization
    save_ups_data,         # Data saving
    get_ups_data,          # Current data reading
    get_supported_value,   # Utility for value access
    data_lock,            # Lock for DB synchronization
    ups_lock,             # Lock for UPS synchronization
    configure_ups         # UPS parameters configuration
)

from .routes import register_routes
from .api import register_api_routes
from .socket_manager import socketio, init_socketio
from .mail import EmailNotifier
from .settings import DB_URI, LOG_FILE, LOG_LEVEL_DEBUG, LOG_LEVEL_INFO
from core.logger import system_logger as logger
from .scheduler import scheduler
logger.info("🏁 Initializating init")

def create_app(config=None):
    # Configure logging first
    root_logger = logger  # Now the centralized system logger
    
    # Remove all existing handlers
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
        
    # Ensure log directory exists
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    
    # Set log level from settings.txt
    log_level = os.environ.get('LOG_LEVEL', 'INFO')
    
    # Use appropriate format based on level
    if log_level == 'DEBUG':
        log_format = logging.Formatter(LOG_LEVEL_DEBUG.split(',')[1].strip())
    else:
        log_format = logging.Formatter(LOG_LEVEL_INFO.split(',')[1].strip())
    
    # Configure root logger to handle all logs
    root_logger.addHandler(system_handler)
    root_logger.setLevel(getattr(logging, log_level))
    
    # Console handler only in debug mode
    if os.environ.get('DEBUG_MODE', 'development') == 'development':
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(log_format)
        root_logger.addHandler(console_handler)
    
    # Create Flask app
    app = Flask(__name__)
    
    # Configure database
    app.settings['SQLALCHEMY_DATABASE_URI'] = DB_URI
    app.settings['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    
    # Initialize extensions
    db.init_app(app)
    init_socketio(app)
    scheduler.init_app(app)
    
    with app.app_context():
        db.create_all()
        from .mail import init_notification_settings
        init_notification_settings()
        # init_log_settings()
    
    # Configure logging only if enabled
    if os.environ.get('LOG_FILE_ENABLED', 'true').lower() == 'true':
        system_handler = logging.FileHandler(LOG_FILE)
        system_handler.setFormatter(log_format)
        root_logger.addHandler(system_handler)
    
    return app