import os
import logging
import sqlite3
import subprocess
from datetime import datetime, timedelta
from flask_sqlalchemy import SQLAlchemy
from flask import current_app
import threading
from sqlalchemy import text, inspect
import re
import pytz
import configparser
from flask_socketio import SocketIO
import pandas as pd
import numpy as np
from core.settings import (
    TIMEZONE, DB_NAME, UPS_HOST, UPS_NAME, 
    UPS_COMMAND, COMMAND_TIMEOUT, CACHE_SECONDS,
    get_configured_timezone, UPS_REALPOWER_NOMINAL
)
from sqlalchemy import func
from core.logger import database_logger as logger
from typing import Optional, Type
from flask_sqlalchemy.model import Model
logger.info("💾 Initializing db_module")

# Type definition for UPSDynamicData
UPSDynamicData: Optional[Type[Model]] = None

__all__ = [
    'db',
    'UPSDynamicData',
    'UPSStaticData',
    'UPSEvent',
    'VariableConfig',
    'get_ups_model',
    'data_lock',
    'ups_data_cache'
]

# Global database instance
db = SQLAlchemy()

# Lock for synchronization
data_lock = threading.Lock()
ups_lock = threading.Lock()

# Global variables for UPS configuration
_ups_host = None             # Hostname/IP of the UPS
_ups_name = None            # Name of the UPS
_ups_command = None         # NUT command to use
_command_timeout = None     # Timeout for commands
_UPSData = None            # Cache of the data model

socketio = SocketIO()

def configure_ups(host, name, command, timeout):
    """
    Configure the UPS connection parameters
    Args:
        host: Hostname or IP of the UPS
        name: Name of the UPS in the NUT system
        command: Command to use (e.g. 'upsc')
        timeout: Timeout in seconds for commands
    """
    global _ups_host, _ups_name, _ups_command, _command_timeout
    _ups_host = host
    _ups_name = name
    _ups_command = command
    _command_timeout = timeout
    logger.info(f"UPS configuration updated: host={host}, name={name}")

# Classes for error handling
class UPSError(Exception):
    """Base class for UPS errors"""
    pass

class UPSConnectionError(UPSError):
    """UPS connection error"""
    pass

class UPSCommandError(UPSError):
    """UPS command execution error"""
    pass

class UPSDataError(UPSError):
    """UPS data error"""
    pass

class DotDict:
    """
    Utility class to access dictionaries as objects
    Example: instead of dict['key'] allows dict.key
    """
    def __init__(self, dictionary):
        for key, value in dictionary.items():
            setattr(self, key, value)

def get_available_variables():
    """Recover all available variables from the UPS"""
    try:
        with ups_lock:
            result = subprocess.run(
                [_ups_command, f'{_ups_name}@{_ups_host}'],
                capture_output=True,
                text=True,
                timeout=_command_timeout
            )

            variables = {}
            for line in result.stdout.splitlines():
                if ':' in line:
                    key, value = line.split(':', 1)
                    variables[key.strip()] = value.strip()
            
            return variables

    except Exception as e:
        logger.error(f"Error in get_available_variables: {str(e)}")
        raise

# Cache of the database models
_UPSStaticData = None
_UPSDynamicData = None

# Correct definition of static UPS fields
STATIC_FIELDS = {
    # Device info
    'device.model', 'device.mfr', 'device.serial', 'device.type', 'device.description',
    'device.contact', 'device.location', 'device.part', 'device.macaddr', 'device.usb_version',
    
    # UPS info
    'ups.model', 'ups.mfr', 'ups.mfr.date', 'ups.serial', 'ups.vendorid',
    'ups.productid', 'ups.firmware', 'ups.firmware.aux', 'ups.type', 'ups.id',
    'ups.display.language', 'ups.contacts',
    
    # Battery static info
    'battery.type', 'battery.date', 'battery.mfr.date', 'battery.packs',
    'battery.packs.external', 'battery.protection',
    
    # Driver info
    'driver.name', 'driver.version', 'driver.version.internal',
    'driver.version.data', 'driver.version.usb'
}

def is_static_field(field_name):
    """Determine if a field is static"""
    # Convert from DB format to NUT format (device_model -> device.model)
    nut_name = field_name.replace('_', '.')
    return nut_name in STATIC_FIELDS

def get_available_ups_variables():
    """
    Recover and analyze the available variables from the real UPS
    Returns:
        dict: Map of available variables and their types
    """
    variables = get_available_variables()
    mapped_columns = {}
    
    for key, value in variables.items():
        db_key = key.replace('.', '_')
        
        # Determine the column type based on the value
        try:
            float(value)
            mapped_columns[db_key] = db.Float
        except ValueError:
            try:
                int(value)
                mapped_columns[db_key] = db.Integer
            except ValueError:
                mapped_columns[db_key] = db.String(255)
    
    return mapped_columns

def create_static_model():
    """
    Create the ORM model for the static UPS data dynamically
    """
    global _UPSStaticData
    if (_UPSStaticData is not None):
        return _UPSStaticData

    # Get the available variables from the UPS
    variables = {k: v for k, v in get_available_variables().items() 
                if k in STATIC_FIELDS}
    
    class UPSStaticData(db.Model):
        __tablename__ = 'ups_static_data'
        __table_args__ = {'extend_existing': True}
        
        # Base fields always present
        id = db.Column(db.Integer, primary_key=True)
        timestamp = db.Column(db.DateTime, default=lambda: datetime.now(get_configured_timezone()))
        
        # Add dynamically columns based on UPS data
        for key, value in variables.items():
            # Convert the key format from NUT to DB
            db_key = key.replace('.', '_')
            
            # Determine the column type based on the value
            try:
                float(value)
                vars()[db_key] = db.Column(db.Float)
            except ValueError:
                try:
                    int(value)
                    vars()[db_key] = db.Column(db.Integer)
                except ValueError:
                    # For string values we use String(255)
                    vars()[db_key] = db.Column(db.String(255))
    
    _UPSStaticData = UPSStaticData
    return UPSStaticData

def get_configured_timezone():
    """Read the timezone from the centralized configuration"""
    try:
        return pytz.timezone(TIMEZONE)
    except Exception as e:
        logger.error(f"Error setting timezone {TIMEZONE}: {e}. Using UTC.")
        return pytz.UTC

# Correct definition of dynamic UPS fields
DYNAMIC_FIELDS = {
    # Device dynamic info
    'device.uptime', 'device.count',

    # UPS dynamic info
    'ups.status', 'ups.alarm', 'ups.time', 'ups.date', 'ups.temperature',
    'ups.load', 'ups.load.high', 'ups.delay.start', 'ups.delay.reboot', 'ups.delay.shutdown',
    'ups.timer.start', 'ups.timer.reboot', 'ups.timer.shutdown', 'ups.test.interval',
    'ups.test.result', 'ups.test.date', 'ups.display.language', 'ups.efficiency',
    'ups.power', 'ups.power.nominal', 'ups.realpower', 'ups.realpower.nominal',
    'ups.beeper.status', 'ups.watchdog.status', 'ups.start.auto', 'ups.start.battery',
    'ups.start.reboot', 'ups.shutdown',

    # Input measurements
    'input.voltage', 'input.voltage.maximum', 'input.voltage.minimum', 'input.voltage.status',
    'input.voltage.nominal', 'input.voltage.extended', 'input.transfer.low', 'input.transfer.high',
    'input.sensitivity', 'input.frequency', 'input.frequency.nominal', 'input.current',
    'input.current.nominal', 'input.realpower', 'input.realpower.nominal',

    # Output measurements
    'output.voltage', 'output.voltage.nominal', 'output.frequency', 'output.frequency.nominal',
    'output.current', 'output.current.nominal',

    # Battery measurements
    'battery.charge', 'battery.charge.low', 'battery.charge.warning', 'battery.voltage',
    'battery.voltage.nominal', 'battery.current', 'battery.temperature', 'battery.runtime',
    'battery.runtime.low', 'battery.alarm.threshold',

    # Ambient measurements
    'ambient.temperature', 'ambient.humidity', 'ambient.temperature.high',
    'ambient.temperature.low', 'ambient.humidity.high', 'ambient.humidity.low'
}

def create_dynamic_model():
    """Create the dynamic model based on the available variables"""
    global _UPSDynamicData
    if (_UPSDynamicData is not None):
        return _UPSDynamicData
    
    # Get only the dynamic variables from the UPS
    all_variables = get_available_variables()
    # Correct the dictionary comprehension syntax
    variables = {k: v for k, v in all_variables.items() if k in DYNAMIC_FIELDS}
    
    # Ensure ups.realpower is always present in the model
    if 'ups.realpower' not in variables and 'ups.load' in variables and 'ups.realpower.nominal' in variables:
        variables['ups.realpower'] = '0'  # Default value
        logger.info("Added ups.realpower to model for calculated values")

    class UPSDynamicData(db.Model):
        __tablename__ = 'ups_dynamic_data'
        __table_args__ = {'extend_existing': True}
        
        # Base columns
        id = db.Column(db.Integer, primary_key=True)
        timestamp_tz = db.Column(db.DateTime(timezone=True), nullable=False, 
                               default=lambda: datetime.now(get_configured_timezone()))
        
        # Ensure ups_realpower and ups_realpower_hrs are always present
        ups_realpower = db.Column(db.Float)
        ups_realpower_hrs = db.Column(db.Float)  # Added field for hourly average
        ups_realpower_days = db.Column(db.Float)  # Field for daily average
        
        # Add only the dynamic columns
        for key, value in variables.items():
            if key != 'ups.realpower':  # Skip ups.realpower because it's already added
                db_key = key.replace('.', '_')
                try:
                    float(value)
                    vars()[db_key] = db.Column(db.Float)
                except ValueError:
                    try:
                        int(value)
                        vars()[db_key] = db.Column(db.Integer)
                    except ValueError:
                        vars()[db_key] = db.Column(db.String(255))
        
        # Add this property for daily power access
        @property
        def daily_power(self):
            return self.ups_realpower_days or 0.0
        
        # Add hook for updating
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            if self.ups_realpower_days is None:
                self.ups_realpower_days = 0.0
    
    _UPSDynamicData = UPSDynamicData
    return UPSDynamicData

def initialize_static_data():
    """
    Initialize the UPS static data in the database
    - Get the current UPS data
    - Create a new record in the static table
    - Save the data in the database
    
    Raises:
        Exception: If an error occurs during initialization
    """
    try:
        UPSStaticData = create_static_model()
        
        # Get the current UPS data
        variables = get_available_variables()
        logger.info("Got current UPS variables for static data initialization")
        
        # Create a new record with ID=1
        static_data = UPSStaticData(id=1)
        
        # Map the fields from NUT format to database format
        static_fields = [c.name for c in UPSStaticData.__table__.columns 
                        if c.name not in ('id', 'timestamp')]
        
        for field in static_fields:
            ups_key = field.replace('_', '.')  # Convert the format (es: device_model -> device.model)
            if ups_key in variables:
                setattr(static_data, field, variables[ups_key])
                logger.debug(f"Set static field {field}={variables[ups_key]}")
        
        # Save the data in the database
        with data_lock:
            db.session.add(static_data)
            db.session.commit()
            logger.info("Static UPS data saved successfully")
            
    except Exception as e:
        logger.error(f"Error initializing static data: {str(e)}")
        with data_lock:
            db.session.rollback()
        raise

def init_database(app):
    """Initialize the application database"""
    try:
        # Get the database path from the URI
        db_path = app.config['SQLALCHEMY_DATABASE_URI'].replace('sqlite:///', '')
        db_dir = os.path.dirname(db_path)
        
        # Ensure the instance directory exists and has the correct permissions
        if not os.path.exists(db_dir):
            os.makedirs(db_dir, mode=0o777)
        else:
            os.chmod(db_dir, 0o777)
            
        # Create the database models
        create_static_model()
        create_dynamic_model()
        
        # Check the report_schedules table
        logger.info("Checking report_schedules table...")
        inspector = inspect(db.engine)
        if 'ups_report_schedules' in inspector.get_table_names():
            columns = {col['name']: col for col in inspector.get_columns('ups_report_schedules')}
            logger.info(f"Found report_schedules table with columns: {list(columns.keys())}")
        else:
            logger.warning("report_schedules table not found, will be created")
        
        db.create_all()
        
        # If the database is new (dynamic tables are empty), insert the initial UPS dynamic data
        insert_initial_dynamic_data()
        
        # Initialize default configurations
        VariableConfig.init_default_config()
        
        # COMMENTED OUT: UPS identity verification
        # The following code is temporarily disabled to avoid startup issues
        """
        # Verify the UPS identity
        logger.info("Verifying UPS identity...")
        is_same_ups, message = verify_ups_identity()
        logger.info(f"UPS verification result: {message}")
        
        # If it's a new installation or a different UPS, initialize the data
        if "First time installation" in message or not is_same_ups:
            if not is_same_ups:
                # Backup only if there was a different UPS
                logger.warning("Different UPS detected - backing up existing database")
                backup_path = backup_database()
                logger.info(f"Previous database backed up to: {backup_path}")
                
                # Remove the old database
                db.session.remove()
                db.engine.dispose()
                os.remove(db_path)
                logger.info(f"Removed old database: {db_path}")
                
                # Recreate the database from scratch
                db.drop_all()
                db.create_all()
                logger.info("Created new database tables")
            
            # Initialize the data for the new UPS
            logger.info("Initializing static data for new UPS...")
            initialize_static_data()
            logger.info("Database initialization complete for new UPS")
        else:
            logger.info("Same UPS verified - using existing database")
        """
        # Instead of verifying UPS identity, always initialize static data if needed
        logger.info("Skipping UPS identity verification - initializing static data if needed...")
        try:
            # Check if static data exists
            result = db.session.execute(text("""
                SELECT COUNT(*) FROM ups_static_data
            """)).scalar()
            
            if result == 0:
                # If no static data exists, initialize it
                logger.info("No static data found - initializing static data...")
                initialize_static_data()
                logger.info("Static data initialization complete")
            else:
                logger.info(f"Found {result} static data entries - using existing database")
        except Exception as e:
            if "no such table" in str(e):
                # If the table doesn't exist, initialize static data
                logger.info("Static data table not found - initializing static data...")
                initialize_static_data()
                logger.info("Static data initialization complete")
                
        # Function to insert initial UPS dynamic data (bootstrap)
        insert_initial_dynamic_data()
        
    except Exception as e:
        logger.error(f"Database initialization error: {str(e)}")
        raise

def get_ups_data():
    """Get the current UPS data"""
    try:
        with ups_lock:
            global _ups_command, _ups_host, _ups_name
            
            # Check if UPS command is configured
            if _ups_command is None:
                # In Docker, upsc è sempre in /usr/bin/upsc
                _ups_command = '/usr/bin/upsc'
                logger.info(f"Using default upsc location: {_ups_command}")
            
            # Check if we have the required parameters
            if not _ups_name or not _ups_host:
                logger.error(f"Missing UPS parameters: name={_ups_name}, host={_ups_host}")
                # Return empty data with basic structure to prevent crashes
                return DotDict({
                    'ups_status': 'ERROR',
                    'ups_model': 'Unknown',
                    'ups_load': 0,
                    'ups_realpower': 0,
                    'input_voltage': 0,
                    'output_voltage': 0,
                    'battery_charge': 0,
                    'battery_runtime': 0
                })
                
            result = subprocess.run([_ups_command, f'{_ups_name}@{_ups_host}'],
                                 capture_output=True, text=True, timeout=_command_timeout)
            
            raw_data = {}
            for line in result.stdout.splitlines():
                if ':' in line:
                    key, value = line.split(':', 1)
                    raw_data[key.strip()] = value.strip()
            
            data = {}
            
            # Map the fields from NUT format to database format and round the float
            for nut_key, value in raw_data.items():
                db_key = nut_key.replace('.', '_')
                try:
                    # Try to convert to float and round to 2 decimal places
                    float_value = float(value)
                    data[db_key] = round(float_value, 2)
                except ValueError:
                    # If it's not a float, use the original value
                    data[db_key] = value
            
            # Calculate ups_realpower only if it doesn't already exist
            try:
                if 'ups.realpower' not in raw_data:
                    load_percent = float(raw_data.get('ups.load', '0'))
                    nominal_power = float(raw_data.get('ups.realpower.nominal', '0'))
                    
                    real_power = (load_percent / 100) * nominal_power
                    data['ups_realpower'] = round(real_power, 2)  # Round to 2 decimal places
                
            except (ValueError, TypeError, KeyError) as e:
                logger.error(f"Error calculating ups.realpower: {str(e)}")
                data['ups_realpower'] = 0.0
            
            return DotDict(data)
            
    except Exception as e:
        logger.error(f"Error getting UPS data: {str(e)}")
        raise UPSDataError(f"Failed to get UPS data: {str(e)}")

def get_supported_value(data, field, default='N/A'):
    """
    Get a value from the UPS data with missing value handling
    
    Args:
        data: Object containing the UPS data
        field: Name of the field to retrieve
        default: Default value if the field doesn't exist
    
    Returns:
        The value of the field or the default value
    """
    try:
        value = getattr(data, field, None)
        if value is not None and value != '':
            return value
        return default
    except AttributeError:
        return default

def save_ups_data():
    """Get the current UPS data"""
    try:
        # Use configured timezone
        tz = get_configured_timezone()
        now = datetime.now(tz)
        
        data = get_ups_data()
        
        # Convert DotDict to standard dictionary
        data_dict = vars(data)
        
        # Log the buffer
        logger.debug(f"📥 Buffer status before add: {len(ups_data_cache.data)}")
        ups_data_cache.add(now, data_dict)
        logger.debug(f"📥 Buffer status after add: {len(ups_data_cache.data)}")
        
        # Check if it's time to save
        success = ups_data_cache.calculate_and_save_averages(now)
        if success:
            logger.info("💾 Successfully saved aligned data to database")
                
        return True, None
    except Exception as e:
        error_msg = f"Error saving data: {str(e)}"
        logger.error(f"❌ {error_msg}")
        return False, error_msg

def get_ups_model() -> Type[Model]:
    """
    Get the ORM model for the UPS dynamic data
    Returns:
        Type[Model]: Class of the SQLAlchemy model for dynamic data
    """
    global _UPSData
    if (_UPSData is None):
        _UPSData = create_dynamic_model()
    return _UPSData

def verify_ups_identity():
    """
    Verify if the currently connected UPS is the same by comparing:
    device_model
    """
    try:
        # Get the current UPS data
        current_ups = get_available_variables()
        
        # Check the presence of the required field
        required_field = 'device.model'
        if required_field not in current_ups:
            msg = f"Required field {required_field} not found in UPS data"
            logger.error(msg)
            return False, msg

        # Read the values from the database if it exists
        db_path = current_app.config['SQLALCHEMY_DATABASE_URI'].replace('sqlite:///', '')
        if not os.path.exists(db_path):
            # If the database doesn't exist, it's a new installation
            return True, "First time installation"

        try:
            # Direct query to read only the necessary field
            result = db.session.execute(text("""
                SELECT device_model 
                FROM ups_static_data 
                WHERE id = 1
            """)).first()
            
            if not result:
                # If there are no data, it's a new installation
                return True, "First time installation"
                
            stored_model = result[0] if result[0] else ''
            
        except Exception as db_error:
            if "no such table" in str(db_error):
                # If the table doesn't exist, it's a new installation
                return True, "First time installation"
            logger.error(f"Database error: {str(db_error)}")
            return False, f"Database error: {str(db_error)}"

        # Compare only the model value
        current_model = current_ups['device.model'].strip()
        
        # If the model is different, the UPS is different
        if current_model != stored_model:
            msg = (
                f"Different UPS detected!\n"
                f"Current Model: {current_model}\n"
                f"Stored Model: {stored_model}"
            )
            logger.warning(msg)
            return False, msg

        return True, "Same UPS verified"
            
    except Exception as e:
        logger.error(f"Error during UPS verification: {str(e)}")
        return False, str(e)

def backup_database():
    """
    Create a database backup
    - Generate a file name with timestamp
    - Copy the database file
    
    Returns:
        str: Path of the created backup file
    
    Raises:
        Exception: If the backup fails
    """
    try:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        db_path = current_app.config['SQLALCHEMY_DATABASE_URI'].replace('sqlite:///', '')
        instance_dir = current_app.config['INSTANCE_PATH']
        backup_name = f"nutify.db.backup_{timestamp}"
        backup_path = os.path.join(instance_dir, backup_name)
        
        # Close the database connections
        db.session.remove()
        db.engine.dispose()
        
        # Copy the file
        import shutil
        shutil.copy2(db_path, backup_path)
        
        logger.info(f"Database backup created: {backup_path}")
        return backup_path
        
    except Exception as e:
        logger.error(f"Error creating database backup: {e}")
        raise

def get_historical_data(start_time, end_time):
    """Get the historical data of the UPS in a time range"""
    try:
        UPSData = get_ups_model()
        data = UPSData.query.filter(
            UPSData.timestamp_tz.between(start_time, end_time)
        ).order_by(UPSData.timestamp_tz.asc())
        
        result = []
        for entry in data.all():
            record = {'timestamp': entry.timestamp_tz.isoformat()}
            
            # Convert all fields to float where possible
            for column in UPSData.__table__.columns:
                if column.name not in ['id', 'timestamp']:
                    try:
                        value = getattr(entry, column.name)
                        if value is not None:
                            if isinstance(value, (int, float)):
                                record[column.name] = float(value)
                            elif isinstance(value, str):
                                try:
                                    record[column.name] = float(value)
                                except ValueError:
                                    record[column.name] = value
                            else:
                                record[column.name] = value
                    except (ValueError, TypeError, AttributeError) as e:
                        logger.debug(f"Skipping field {column.name}: {e}")
                        continue
            
            result.append(record)
        
        return result
    except Exception as e:
        logger.error(f"Error retrieving historical data: {e}")
        return []
    finally:
        db.session.close()

class UPSEvent(db.Model):
    """Model for UPS events"""
    __tablename__ = 'ups_events_socket'
    
    id = db.Column(db.Integer, primary_key=True)
    timestamp_tz = db.Column(db.DateTime(timezone=True), nullable=False, default=lambda: datetime.now(get_configured_timezone()))
    timestamp_tz_begin = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(get_configured_timezone()))
    timestamp_tz_end = db.Column(db.DateTime(timezone=True))
    ups_name = db.Column(db.String(255))
    event_type = db.Column(db.String(50))
    event_message = db.Column(db.Text)
    source_ip = db.Column(db.String(45))
    acknowledged = db.Column(db.Boolean, default=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        
        # Set the timestamp in the configured timezone
        now = datetime.now(get_configured_timezone())
        self.timestamp_tz = now
        self.timestamp_tz_begin = now

    def to_dict(self):
        """Convert the object to a dictionary"""
        return {
            'id': self.id,
            'timestamp_tz': self.timestamp_tz.isoformat() if self.timestamp_tz else None,
            'timestamp_tz_begin': self.timestamp_tz_begin.isoformat() if self.timestamp_tz_begin else None,
            'timestamp_tz_end': self.timestamp_tz_end.isoformat() if self.timestamp_tz_end else None,
            'ups_name': self.ups_name,
            'event_type': self.event_type,
            'event_message': self.event_message,
            'source_ip': self.source_ip,
            'acknowledged': self.acknowledged
        }

def get_event_type(event_message):
    """
    Determine the event type from the upsmon message.
    Handles messages in the format "UPS ups@localhost: <event>"
    """
    event_message = event_message.lower()
    
    # Remove the prefix "UPS ups@localhost"
    if 'ups ' in event_message:
        event_message = event_message.split('ups ')[1]
    if '@localhost' in event_message:
        event_message = event_message.split('@localhost')[1]
    if ': ' in event_message:
        event_message = event_message.split(': ')[1]
        
    event_message = event_message.strip()
    
    # Standard UPS states
    if 'on line power' in event_message:
        return 'ONLINE'
    elif 'on battery' in event_message:
        return 'ONBATT'
    elif 'low battery' in event_message:
        return 'LOWBATT'
    elif 'battery needs replacement' in event_message:
        return 'REPLBATT'
    elif 'communication lost' in event_message:
        return 'COMMFAULT'
    elif 'shutdown in progress' in event_message:
        return 'SHUTDOWN'
    elif 'ups overloaded' in event_message:
        return 'OVERLOAD'
    elif 'battery charging' in event_message:
        return 'CHARGING'
    elif 'battery discharging' in event_message:
        return 'DISCHARGING'
    elif 'bypass active' in event_message:
        return 'BYPASS'
    elif 'test in progress' in event_message:
        return 'CAL'  # Calibration/Test
    elif 'ups failed' in event_message:
        return 'FAULT'
    elif 'temperature high' in event_message:
        return 'OVERHEAT'
    elif 'input voltage high' in event_message:
        return 'OVERVOLTAGE'
    elif 'input voltage low' in event_message:
        return 'UNDERVOLTAGE'
    elif 'ups off' in event_message:
        return 'OFF'
    elif 'ups initialized' in event_message or 'startup' in event_message:
        return 'STARTUP'
    
    # If no specific match is found, return UNKNOWN
    logger.warning(f"Unknown UPS event type: {event_message}")
    return 'UNKNOWN'

def handle_ups_event(event_data):
    try:
        now = datetime.now(pytz.UTC)
        
        event = UPSEvent(
            timestamp_tz=now,
            timestamp_tz_begin=now,
            ups_name=event_data.get('ups'),
            event_type=event_data.get('event'),
            event_message=str(event_data),
            source_ip=None,
            acknowledged=False
        )
        
        db.session.add(event)
        db.session.commit()

        #  Send the event via WebSocket if possible
        try:
            from flask import current_app
            if hasattr(current_app, 'socketio'):
                current_app.socketio.emit('ups_event', {
                    'event_type': event_data['event'],
                    'ups_data': event_data
                })
        except Exception as ws_error:
            logger.warning(f"Could not emit WebSocket event: {ws_error}")

        return True, "Event handled successfully", event_data
    except Exception as e:
        logger.error(f"Error handling UPS event: {e}", exc_info=True)
        return False, str(e), None

class UPSCommand(db.Model):
    """Model for UPS commands history"""
    __tablename__ = 'ups_variables_upscmd'
    
    id = db.Column(db.Integer, primary_key=True)
    command = db.Column(db.String(100), nullable=False)
    timestamp = db.Column(db.DateTime, nullable=False, default=lambda: datetime.now(get_configured_timezone()))
    success = db.Column(db.Boolean, nullable=False)
    output = db.Column(db.Text)
    
    def __repr__(self):
        return f'<UPSCommand {self.command} @ {self.timestamp}>'

    def to_dict(self):
        """Converts the object to a dictionary"""
        return {
            'id': self.id,
            'command': self.command,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'success': self.success,
            'output': self.output
        }

class VariableConfig(db.Model):
    """Model for variable configuration"""
    __tablename__ = 'ups_opt_variable_config'

    id = db.Column(db.Integer, primary_key=True)
    currency = db.Column(db.String(3), nullable=False, default='EUR')
    price_per_kwh = db.Column(db.DECIMAL(10,4), nullable=False, default=0.25)
    co2_factor = db.Column(db.DECIMAL(10,4), nullable=False, default=0.4)       
    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(get_configured_timezone()))
    updated_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(get_configured_timezone()), onupdate=lambda: datetime.now(get_configured_timezone()))

    @staticmethod
    def init_default_config():
       """Initialize default configuration if not exists"""
       try:
           with data_lock:
               if not VariableConfig.query.first():
                   default_config = VariableConfig(
                       id=1,
                       currency='EUR',
                       price_per_kwh=0.25,
                       co2_factor=0.4
                   )
                   db.session.add(default_config)
                   db.session.commit()
                   logger.info("Default variable configuration created")
       except Exception as e:
        logger.error(f"Error initializing default variable config: {str(e)}")

# CAHCE DATABASE

class UPSDataCache:
    def __init__(self, size=5):
        """
        Initialize the cache with Pandas
        Args:
            size (int): Size of the buffer in seconds
        """
        self.size = size
        self.data = []
        self.df = None
        self.next_save_time = None
        self.next_hour = None  #  For tracking the next hour
        self.hourly_data = []  # Buffer for hourly data
        self.last_daily_aggregation = None
        logger.info(f"📊 Initialized UPS data cache (size: {size} seconds)")

    def get_next_hour(self, current_time):
        """Calculate the exact next hour"""
        tz = get_configured_timezone()
        local_time = current_time.astimezone(tz)
        next_hour = local_time.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        return next_hour

    def calculate_hourly_average(self):
        """Calculate the hourly average of ups_realpower"""
        if not self.hourly_data:
            return None
            
        df = pd.DataFrame(self.hourly_data)
        if 'ups_realpower' not in df.columns:
            return None
            
        return round(df['ups_realpower'].mean(), 2)

    def calculate_and_save_averages(self, current_time):
        logger.debug(f"🕒 Current time: {current_time}")
        logger.debug(f"⏰ Next daily aggregation check: {self.last_daily_aggregation}")
        try:
            # Initialize next_hour if necessary
            if self.next_hour is None:
                self.next_hour = self.get_next_hour(current_time)

            # Check if it's time to save the normal data
            if not self.is_save_time(current_time):
                return False

            # Calculate averages using the existing code
            averages = self.calculate_averages()
            if not averages:
                return False

            logger.info(f"📊 Processing averages from {len(self.data)} samples at {self.next_save_time}")

            # Create a new record
            UPSDynamicData = get_ups_model()
            dynamic_data = UPSDynamicData()

            # Set only timestamp_tz
            dynamic_data.timestamp_tz = self.next_save_time

            # Set the average values
            for key, value in averages.items():
                if hasattr(dynamic_data, key):
                    setattr(dynamic_data, key, value)

            # Add to hourly buffer if ups_realpower is present
            if 'ups_realpower' in averages:
                self.hourly_data.append({
                    'timestamp': self.next_save_time,  # We use next_save_time which is already in the correct timezone
                    'ups_realpower': averages['ups_realpower']
                })

                # Check if it's time to calculate the hourly average
                current_tz = current_time.astimezone(self.next_hour.tzinfo)
                if current_tz >= self.next_hour:
                    exact_hour = self.next_hour.astimezone(get_configured_timezone()) - timedelta(hours=1)

                    # Correct query with timezone filter
                    hour_data = UPSDynamicData.query.filter(
                        UPSDynamicData.timestamp_tz >= exact_hour,
                        UPSDynamicData.timestamp_tz < exact_hour + timedelta(hours=1)
                    ).all()

                    if hour_data:
                        powers = [d.ups_realpower for d in hour_data if d.ups_realpower is not None]
                        if powers:
                            hourly_avg = sum(powers) / len(powers)
                            dynamic_data.ups_realpower_hrs = round(hourly_avg, 2)
                            logger.info(f"📊 Calculated hourly average from {len(powers)} records: {hourly_avg}W. Saving ups_realpower_hrs = {dynamic_data.ups_realpower_hrs}")
                        else:
                            logger.warning("📊 No power data available for hourly average calculation.")
                    else:
                        logger.warning("📊 No hourly data found in database for hourly average calculation.")


                    # Reset for the next hour
                    self.hourly_data = []
                    self.next_hour = self.get_next_hour(current_time)
                    logger.info(f"Next hourly calculation at: {self.next_hour}")
                else:
                    logger.debug("⏰ Not yet time for hourly calculation.")


            # Save in the database
            with data_lock:
                db.session.add(dynamic_data)
                db.session.commit()
                logger.info(f"💾 Successfully saved averaged data at {self.next_save_time}")

            # Clean the buffer and update next_save_time
            self.data = []
            self.df = None
            self.next_save_time = self.get_next_minute(current_time)
            logger.info(f"Next save scheduled for: {self.next_save_time}")

            if self.should_aggregate_daily(current_time):
                self.aggregate_daily_data(current_time)

            return True

        except Exception as e:
            logger.error(f"❌ Error saving averaged data: {str(e)}", exc_info=True)
            return False

    def get_next_minute(self, current_time):
        """
        Calculate the exact next minute in the configured timezone
        Args:
            current_time (datetime): Current timestamp
        Returns:
            datetime: Exact next minute timestamp
        """
        # Get the configured timezone
        tz = get_configured_timezone()
        
        # Convert the current time to the configured timezone
        local_time = current_time.astimezone(tz)
        
        # Calculate the exact next minute
        next_minute = local_time.replace(second=0, microsecond=0) + timedelta(minutes=1)
        
        logger.debug(f"Next save time calculated: {next_minute}")
        return next_minute

    def add(self, timestamp, data):
        """
        Add data to the buffer and initialize next_save_time if necessary
        Args:
            timestamp (datetime): Data timestamp
            data (dict): UPS data dictionary
        """
        # If it's the first data point, initialize next_save_time
        if self.next_save_time is None:
            self.next_save_time = self.get_next_minute(timestamp)
            logger.info(f"First data point received. Next save scheduled for: {self.next_save_time}")

        # Add to the buffer
        self.data.append((timestamp, data))
        
        # Convert the buffer to DataFrame
        df_data = []
        for ts, d in self.data:
            row = {'timestamp': ts, **d}
            df_data.append(row)
        
        self.df = pd.DataFrame(df_data)
        logger.debug(f"📥 Added data point (buffer: {len(self.data)})")

    def is_save_time(self, current_time):
        """
        Check if it's time to save the data
        Args:
            current_time (datetime): Current timestamp
        Returns:
            bool: True if it's time to save
        """
        if self.next_save_time is None:
            return False
            
        # Convert the current time to the same timezone as next_save_time
        current_tz = current_time.astimezone(self.next_save_time.tzinfo)
        
        return current_tz >= self.next_save_time

    def calculate_averages(self):
        """
        Calculate averages using Pandas:
        - Automatically identifies numeric columns
        - Calculates average for numeric values
        - Takes last value for non-numeric columns
        Returns:
            dict: Dictionary with averages and last values
        """
        if self.df is None or self.df.empty:
            logger.warning("⚠️ No data available for averaging")
            return None

        try:
            logger.info("📊 Starting Pandas data processing...")
            
            # Identify numeric columns
            numeric_cols = self.df.select_dtypes(include=[np.number]).columns
            non_numeric_cols = self.df.select_dtypes(exclude=[np.number]).columns
            non_numeric_cols = non_numeric_cols.drop('timestamp') if 'timestamp' in non_numeric_cols else non_numeric_cols

            logger.debug(f"🔢 Processing {len(numeric_cols)} numeric columns with Pandas")
            # Calculate averages for numeric columns (rounded to 2 decimal places)
            averages = self.df[numeric_cols].mean().round(2).to_dict()

            logger.debug(f"📝 Processing {len(non_numeric_cols)} non-numeric columns")
            # Take last value for non-numeric columns
            last_values = self.df[non_numeric_cols].iloc[-1].to_dict()

            # Combine results
            result = {**averages, **last_values}
            logger.info(f"✅ Pandas processing complete - averaged {len(numeric_cols)} numeric fields")
            return result

        except Exception as e:
            logger.error(f"❌ Error in Pandas processing: {str(e)}")
            return None

    def is_full(self):
        """Check if the buffer is full"""
        return len(self.data) >= self.size

    def should_aggregate_daily(self, current_time):
        """Check if it's midnight for daily aggregation"""
        tz = get_configured_timezone()
        local_time = current_time.astimezone(tz)
        logger.debug(f"🕰️ should_aggregate_daily - Local time: {local_time}, Hour: {local_time.hour}, Minute: {local_time.minute}")

        if local_time.hour == 0 and local_time.minute == 0:
            if self.last_daily_aggregation != local_time.date():
                self.last_daily_aggregation = local_time.date()
                logger.info("📅 It's midnight - Daily aggregation should start.")
                return True
        logger.debug("📅 Not midnight yet, daily aggregation not needed.")
        return False

    def aggregate_daily_data(self, current_time):
        """Perform daily aggregation"""
        try:
            tz = get_configured_timezone()
            aggregation_time = current_time.astimezone(tz).replace(hour=0, minute=0, second=0)
            logger.debug(f"📅 Starting daily aggregation at: {aggregation_time}")

            # Get the UPSDynamicData model
            UPSDynamicData = get_ups_model()  # Define UPSDynamicData here

            # Calculate the average of hourly averages
            logger.debug("📅 Querying hourly averages for daily aggregation...")
            daily_data = db.session.query(
                func.avg(UPSDynamicData.ups_realpower_hrs).label('daily_avg')
            ).filter(
                UPSDynamicData.timestamp_tz >= aggregation_time - timedelta(days=1),
                UPSDynamicData.timestamp_tz < aggregation_time
            ).scalar()

            if daily_data:
                daily_avg = round(float(daily_data), 2)
                logger.debug(f"📅 Daily average power calculated: {daily_avg}W")

                new_daily = UPSDynamicData(
                    timestamp_tz=aggregation_time - timedelta(days=1),
                    ups_realpower_days=daily_avg
                )

                with data_lock:
                    db.session.add(new_daily)
                    db.session.commit()
                    logger.info(f"📅 Daily aggregation saved: {daily_avg}W for {aggregation_time.date()}")
            else:
                logger.warning("📅 No hourly data found for daily aggregation.")

        except Exception as e:
            logger.error(f"❌ Daily aggregation error: {str(e)}", exc_info=True)
            db.session.rollback()

    def get(self):
        """
        Return the current data stored in cache.
        """
        return self.data

# Initialize the global cache
ups_data_cache = UPSDataCache(size=CACHE_SECONDS)

def calculate_realpower(data):
    """
    Calculate ups_realpower (real power) using the direct formula:
    Power = realpower_nominal * (ups.load/100)
    Use the value from the configuration if not available from the UPS
    """
    try:
        if 'ups.realpower' not in data:
            load_percent = float(data.get('ups.load', '0'))
            # First try to get the value from the UPS, otherwise use the one from settings
            nominal_power = float(data.get('ups.realpower.nominal', UPS_REALPOWER_NOMINAL))
            
            # Direct formula
            realpower = (nominal_power * load_percent) / 100
            data['ups.realpower'] = str(round(realpower, 2))
            logger.debug(f"Calculated realpower: {realpower:.2f}W (nominal={nominal_power}W, load={load_percent}%)")
    except Exception as e:
        logger.error(f"Error calculating realpower: {str(e)}")
        data['ups.realpower'] = "0"
    
    return data

def calculate_daily_power():
    """Calculate and save the daily average power"""
    try:
        UPSDynamicData = get_ups_model()
        tz = get_configured_timezone()
        now = datetime.now(tz)
        
        # Calculate the previous day
        previous_day = now - timedelta(days=1)
        start_date = previous_day.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        
        # Get all hourly data of the previous day
        hourly_data = UPSDynamicData.query.filter(
            UPSDynamicData.timestamp_tz >= start_date,
            UPSDynamicData.timestamp_tz < end_date,
            UPSDynamicData.ups_realpower_hrs.isnot(None)
        ).all()
        
        if not hourly_data:
            logger.warning("No hourly data available for daily aggregation")
            return
        
        # Calculate the daily average power
        daily_power = sum([d.ups_realpower_hrs for d in hourly_data]) / len(hourly_data)
        
        # Create or update the daily record
        daily_record = UPSDynamicData(
            timestamp_tz=start_date,
            ups_realpower_days=round(daily_power, 2)
        )
        
        with data_lock:
            db.session.add(daily_record)
            db.session.commit()
            logger.info(f"💾 Saved daily power average: {daily_power:.2f}W for {start_date.date()}")
            
    except Exception as e:
        logger.error(f"Error in daily power calculation: {str(e)}")
        db.session.rollback()

def get_hourly_power(hour_start):
    """Get all data of the specific hour from the database"""
    try:
        tz = get_configured_timezone()
        hour_start = hour_start.astimezone(tz).replace(minute=0, second=0, microsecond=0)
        hour_end = hour_start + timedelta(hours=1)
        
        return UPSDynamicData.query.filter(
            UPSDynamicData.timestamp_tz >= hour_start,
            UPSDynamicData.timestamp_tz < hour_end
        ).all()
    except Exception as e:
        logger.error(f"Error querying hourly data: {str(e)}")
        return []

class ReportSchedule(db.Model):
    """Model for scheduled reports"""
    __tablename__ = 'ups_report_schedules'
    
    id = db.Column(db.Integer, primary_key=True)
    time = db.Column(db.String(5), nullable=False)  # Format: HH:MM
    days = db.Column(db.String(20), nullable=False)  # Format: 0,1,2,3,4,5,6 or * for all days
    reports = db.Column(db.String(200), nullable=False)  # Comma-separated list of report types
    email = db.Column(db.String(255))  # Email to send report to
    period_type = db.Column(db.String(10), nullable=False, default='daily')  # yesterday, last_week, last_month, range
    from_date = db.Column(db.DateTime(timezone=True))  # Start date for 'range' period_type
    to_date = db.Column(db.DateTime(timezone=True))  # End date for 'range' period_type
    enabled = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), 
                          default=lambda: datetime.now(get_configured_timezone()))
    updated_at = db.Column(db.DateTime(timezone=True), 
                          default=lambda: datetime.now(get_configured_timezone()),
                          onupdate=lambda: datetime.now(get_configured_timezone()))
    
    def to_dict(self):
        tz = get_configured_timezone()
        return {
            'id': self.id,
            'time': self.time,
            'days': [int(d) for d in self.days.split(',') if d.isdigit()],
            'reports': self.reports.split(','),
            'email': self.email,
            'period_type': self.period_type,
            'from_date': self.from_date.astimezone(tz).isoformat() if self.from_date else None,
            'to_date': self.to_date.astimezone(tz).isoformat() if self.to_date else None,
            'enabled': self.enabled,
            'created_at': self.created_at.astimezone(tz).isoformat() if self.created_at else None,
            'updated_at': self.updated_at.astimezone(tz).isoformat() if self.updated_at else None
        }

# Function to insert initial UPS dynamic data (bootstrap)
def insert_initial_dynamic_data():
    """
    If the database is just created (no records in the dynamic table),
    insert the data obtained via upsc (function get_available_variables)
    in the dynamic table. This is done only once.
    """
    try:
        # Get the model for dynamic data
        UPSDynamicData = get_ups_model()
        # Check if the dynamic table is empty
        if db.session.query(UPSDynamicData).first() is None:
            current_data = get_available_variables()
            new_record = UPSDynamicData(timestamp_tz=datetime.now(get_configured_timezone()))
            # Set the values in the dynamic columns (keys are converted from "battery.date" to "battery_date")
            for key, value in current_data.items():
                column_name = key.replace('.', '_')
                if hasattr(new_record, column_name):
                    try:
                        # If it's numeric, try to convert to float
                        numeric_value = float(value)
                        setattr(new_record, column_name, numeric_value)
                    except Exception:
                        # Otherwise, assign it as a string
                        setattr(new_record, column_name, value)
            with data_lock:
                db.session.add(new_record)
                db.session.commit()
            logger.info("Initial dynamic UPS data inserted successfully.")
        else:
            logger.info("Dynamic UPS data already exists; initial insertion skipped.")
    except Exception as e:
        logger.error(f"Error inserting initial dynamic data: {str(e)}")
