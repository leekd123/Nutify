from flask import jsonify
from flask_socketio import emit
from datetime import datetime
import pytz
from .db_module import db, data_lock, UPSEvent
from .mail import handle_notification
from .settings import TIMEZONE, get_configured_timezone
from core.logger import upsmon_logger as logger
logger.info("🌑 Initializing upsmon_client")

def handle_nut_event(app, data):
    """
    Handles NUT events received via Unix socket
    
    Args:
        app: Flask application instance
        data: Dictionary containing ups and event
    """
    try:
        logger.info(f"Processing NUT event: {data}")
        
        if not data:
            logger.error("No data received")
            return False
            
        ups = data.get('ups', 'unknown')
        event = data.get('event', 'unknown')
        
        # Use only the configured timezone
        tz = get_configured_timezone()
        now = datetime.now(tz)
        
        # Save in the database
        with data_lock:
            db_event = UPSEvent(
                ups_name=ups,
                event_type=event,
                event_message=str(data),
                timestamp_tz=now,
                timestamp_tz_begin=now,
                source_ip=None,
                acknowledged=False
            )
            db.session.add(db_event)
            db.session.commit()
            logger.info(f"Event saved to database with id: {db_event.id}")
        
        # Save in the app memory for the events page
        if not hasattr(app, 'events_log'):
            app.events_log = []
        app.events_log.append(data)
        
        # Send via websocket
        if hasattr(app, 'socketio'):
            app.socketio.emit('nut_event', data)
            logger.debug("Event sent via WebSocket")
        
        # Handle email notification
        try:
            handle_notification(data)  # Pass the event to mail.py
            logger.info("Email notification sent")
        except Exception as e:
            logger.error(f"Error sending email: {str(e)}")
        
        # Handle related events (e.g. ONLINE after ONBATT)
        if event == 'ONLINE':
            with data_lock:
                prev_event = UPSEvent.query.filter_by(
                    event_type='ONBATT',
                    timestamp_tz_end=None
                ).order_by(UPSEvent.timestamp_tz.desc()).first()
                
                if prev_event:
                    prev_event.timestamp_tz_end = now
                    db.session.commit()
                    logger.debug("Closed previous ONBATT event")
        
        return True
        
    except Exception as e:
        logger.error(f"Error handling NUT event: {str(e)}", exc_info=True)
        return False

def get_event_history(app):
    """
    Retrieve the event history
    
    Args:
        app: Flask application instance
        
    Returns:
        Response: JSON with the event history
    """
    try:
        if not hasattr(app, 'events_log'):
            app.events_log = []
        return jsonify(app.events_log)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def get_events_table(rows='all'):
    """
    Retrieve the events table from the database
    
    Args:
        rows: Number of rows to retrieve ('all' for all)
        
    Returns:
        dict: Events table data
    """
    try:
        logger.debug(f"Request for events table with rows={rows}")
        
        query = UPSEvent.query.order_by(UPSEvent.timestamp_tz.desc())
        
        if rows != 'all':
            query = query.limit(int(rows))
            
        events = query.all()
        logger.debug(f"Found {len(events)} events")
        
        # Get the column names
        columns = [column.name for column in UPSEvent.__table__.columns]
        
        # Prepare the row data
        rows_data = []
        for event in events:
            row = {}
            for column in columns:
                value = getattr(event, column)
                if isinstance(value, datetime):
                    value = value.strftime('%Y-%m-%d %H:%M:%S')
                row[column] = value
            rows_data.append(row)
            
        return {
            'columns': columns,
            'rows': rows_data
        }
                
    except Exception as e:
        logger.error(f"Error retrieving events: {str(e)}", exc_info=True)
        raise

def acknowledge_event(event_id):
    """
    Mark an event as acknowledged
    
    Args:
        event_id: ID of the event to acknowledge
        
    Returns:
        tuple: (success, message)
    """
    try:
        with data_lock:
            event = UPSEvent.query.get(event_id)
            if event:
                event.acknowledged = True
                db.session.commit()
                return True, "Event acknowledged"
            return False, "Event not found"
    except Exception as e:
        logger.error(f"Error in handling the acknowledge: {str(e)}", exc_info=True)
        return False, str(e)

