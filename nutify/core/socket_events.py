from flask_socketio import emit
from flask import request, current_app
from .socket_manager import socketio
from .db_module import db, UPSCommand, data_lock
from core.logger import socket_logger as logger
logger.info("🌐 Initializing socket_events")

from datetime import datetime

@socketio.on('connect')
def handle_connect():
    """Handles the connection of a client"""
    logger.info(f'🟢 Client connected - SID: {request.sid}')
    emit('connect_response', {'status': 'connected', 'sid': request.sid})
    # Send immediately the current data
    emit_command_stats()
    emit_command_logs()

@socketio.on('request_initial_data')
def handle_initial_data():
    """Handles the request for initial data"""
    emit_command_stats()
    emit_command_logs()

@socketio.on('disconnect')
def handle_disconnect():
    """Handles the disconnection of a client"""
    logger.info(f'🔴 Client disconnected - SID: {request.sid}')

def emit_command_stats():
    """Emits the command statistics"""
    try:
        with data_lock:
            # Calculate the statistics
            total_commands = UPSCommand.query.count()
            successful_commands = UPSCommand.query.filter_by(success=True).count()
            failed_commands = UPSCommand.query.filter_by(success=False).count()
            
            stats = {
                'total': total_commands,
                'successful': successful_commands,
                'failed': failed_commands
            }
            
            # Emit the event with the statistics
            socketio.emit('command_stats_update', stats)
            
    except Exception as e:
        logger.error(f"Error in the emission of the statistics: {str(e)}")

def emit_command_logs():
    """Emits the recent command logs"""
    try:
        with data_lock:
            # Retrieve the last 10 commands
            recent_commands = UPSCommand.query.order_by(
                UPSCommand.timestamp.desc()
            ).limit(10).all()
            
            logs = [{
                'command': cmd.command,
                'success': cmd.success,
                'output': cmd.output,
                'timestamp': cmd.timestamp.isoformat()
            } for cmd in recent_commands]
            
            # Emit the event with the logs
            socketio.emit('command_logs_update', logs)
            
    except Exception as e:
        logger.error(f"Error in the emission of the logs: {str(e)}")

def notify_command_executed(command, success, output):
    """
    Notify the execution of a new command
    Call after each command execution
    """
    try:
        with current_app.app_context():
            # Emit the event of the new command
            socketio.emit('command_executed', {
                'command': command,
                'success': success,
                'output': output,
                'timestamp': datetime.now().isoformat()
            })
            
            # Update statistics and logs
            emit_command_stats()
            emit_command_logs()
            
    except Exception as e:
        logger.error(f"Error in the notification of the command: {str(e)}")

def notify_variable_update(data):
    """Notify the update of a variable"""
    try:
        socketio.emit('variable_update', data)
        emit_variable_history()
    except Exception as e:
        logger.error(f"Error in the notification of the variable: {str(e)}")

def emit_variable_history():
    """Emits the updated variable history"""
    try:
        from .upsrw import get_variable_history
        history = get_variable_history()
        socketio.emit('history_update', history)
    except Exception as e:
        logger.error(f"Error in the emission of the history: {str(e)}") 