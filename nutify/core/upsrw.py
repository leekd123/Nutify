import subprocess
import logging
import re
import shlex
from datetime import datetime
from .db_module import db, data_lock
from .socket_events import notify_variable_update
from sqlalchemy import Column, Integer, String, DateTime, Boolean
from core.settings import (
    UPS_HOST, UPS_NAME,
    UPSCMD_USER as UPS_USER,     
    UPSCMD_PASSWORD as UPS_PASSWORD,  
    UPSCMD_COMMAND,
    get_configured_timezone
)
import time
from core.logger import ups_logger as logger
logger.info("🌑 Initializing upsrw")

class UPSVariable(db.Model):
    """Model to track changes to UPS variables"""
    __tablename__ = 'ups_variables_upsrw'
    
    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    old_value = Column(String(255))
    new_value = Column(String(255), nullable=False)
    timestamp_tz = Column(DateTime, default=lambda: datetime.now(get_configured_timezone()))
    success = Column(Boolean, default=True)

def get_ups_variables():
    """
    Get the list of available UPS variables
    Returns: list of dictionaries with name, value, description
    """
    try:
        logger.info(f"Interrogation of variables for UPS {UPS_NAME}@{UPS_HOST}")
        cmd = f"upsrw -u {UPS_USER} -p {UPS_PASSWORD} {UPS_NAME}@{UPS_HOST}"
        result = subprocess.run(cmd.split(), capture_output=True, text=True)
        
        if result.returncode != 0:
            logger.error(f"Error in the execution of upsrw: {result.stderr}")
            return []
            
        logger.debug(f"Output raw upsrw:\n{result.stdout}")
        
        variables = []
        current_var = None
        
        for line in result.stdout.split('\n'):
            line = line.strip()
            if not line:
                continue
                
            # New variable starts with [name]
            if line.startswith('[') and line.endswith(']'):
                if current_var:
                    variables.append(current_var)
                name = line[1:-1]  # Removes the square brackets
                current_var = {
                    'name': name,
                    'value': '',
                    'description': '',
                    'type': '',
                    'max_length': ''
                }
            # Description is the first line after the name
            elif current_var and not current_var['description']:
                current_var['description'] = line
            # Type
            elif line.startswith('Type:'):
                current_var['type'] = line.split(':', 1)[1].strip()
            # Maximum length
            elif line.startswith('Maximum length:'):
                current_var['max_length'] = line.split(':', 1)[1].strip()
            # Value
            elif line.startswith('Value:'):
                current_var['value'] = line.split(':', 1)[1].strip()
                
        if current_var:
            variables.append(current_var)
            
        logger.info(f"Found {len(variables)} UPS variables")
        return variables
        
    except Exception as e:
        logger.error(f"Error in the recovery of UPS variables: {str(e)}")
        return []

def set_ups_variable(name, value):
    """
    Set the value of a UPS variable
    Parameters:
        name: name of the variable
        value: new value
    Returns: (success, message)
    """
    try:
        # First read the current value
        old_value = None
        variables = get_ups_variables()
        for var in variables:
            if var['name'] == name:
                old_value = var['value']
                break
                
        if old_value is None:
            return False, f"Variable {name} not found"
            
        # Execute the set command
        cmd = f"upsrw -u {UPS_USER} -p {UPS_PASSWORD} -s {name}={value} {UPS_NAME}@{UPS_HOST}"
        logger.debug(f"Execution of command: {cmd}")
        
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        logger.debug(f"Command output: stdout={result.stdout}, stderr={result.stderr}")

        # If the command returns "OK" in stderr, it is a success
        if result.stderr.strip() == "OK":
            logger.info(f"Command executed successfully for {name}={value}")
            
            # Register the modification in the database
            with data_lock:
                modification = UPSVariable(
                    name=name,
                    old_value=old_value,
                    new_value=value,
                    success=True
                )
                db.session.add(modification)
                db.session.commit()
            
            # Notify via websocket
            notify_variable_update({
                'name': name,
                'value': value,
                'success': True
            })
            
            # Wait for the UPS to update the value (up to 3 attempts)
            max_attempts = 3
            for attempt in range(max_attempts):
                time.sleep(1)  # Wait 1 second between attempts
                
                new_variables = get_ups_variables()
                for var in new_variables:
                    if var['name'] == name and var['value'] == value:
                        logger.info(f"Value updated correctly after {attempt + 1} attempts")
                        return True, "Variable updated successfully"
                
                logger.debug(f"Attempt {attempt + 1}: value not yet updated")
            
            logger.warning(f"The value was not updated after {max_attempts} attempts")
            return True, "Command sent successfully, but the value may take time to update"
            
        elif result.returncode != 0:
            logger.error(f"Error in the execution of upsrw: {result.stderr}")
            return False, f"Error: {result.stderr}"

        return False, "Error updating the variable"
            
    except Exception as e:
        logger.error(f"Error setting variable {name}: {str(e)}")
        return False, str(e)

def get_variable_history(variable_name=None):
    """Get the history of variable changes
    
    Args:
        variable_name (str, optional): Name of the variable to filter. If None, returns all variables.
    
    Returns:
        list: List of dictionaries with the history of changes
    """
    try:
        with data_lock:
            query = UPSVariable.query
            
            # Filter by variable name if provided
            if variable_name:
                query = query.filter(UPSVariable.name == variable_name)
                
            history = query.order_by(
                UPSVariable.timestamp_tz.desc()
            ).limit(100).all()
            
            return [{
                'name': h.name,
                'old_value': h.old_value,
                'new_value': h.new_value,
                'timestamp': h.timestamp_tz.isoformat(),
                'success': h.success
            } for h in history]
            
    except Exception as e:
        logger.error(f"Error retrieving history: {str(e)}")
        return []

def clear_variable_history():
    """Clear the history of changes"""
    try:
        with data_lock:
            UPSVariable.query.delete()
            db.session.commit()
        return True
    except Exception as e:
        logger.error(f"Error clearing history: {str(e)}")
        return False 