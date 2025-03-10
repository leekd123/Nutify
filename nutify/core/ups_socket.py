import socket
import os
import threading
from core.logger import web_logger as logger
logger.info("📡 Initializing ups_socket")

from .upsmon_client import handle_nut_event

class UPSSocketServer:
    def __init__(self, app):
        self.app = app
        self.socket_path = '/tmp/ups_events.sock'
        logger.info(f"🔌 Initializing UPS Socket Server with path: {self.socket_path}")
        self.event_thread = None
        self.running = False
        
    def start(self):
        """Start the socket server in a separate thread"""
        logger.info("🚀 Starting UPS Socket Server...")
        self.running = True
        self.event_thread = threading.Thread(target=self._run_server)
        self.event_thread.daemon = True
        self.event_thread.start()
        logger.info("✅ Socket Server thread started successfully")
        
    def stop(self):
        """Stop the socket server"""
        logger.info("🛑 Stopping UPS Socket Server...")
        self.running = False
        if os.path.exists(self.socket_path):
            try:
                os.remove(self.socket_path)
                logger.info(f"🗑️ Removed socket file: {self.socket_path}")
            except Exception as e:
                logger.error(f"❌ Error removing socket file: {str(e)}")
            
    def _run_server(self):
        """Main server loop"""
        try:
            logger.info("🔄 Starting main server loop...")
            
            # Cleanup old socket if it exists
            if os.path.exists(self.socket_path):
                logger.info(f"🧹 Cleaning up existing socket at {self.socket_path}")
                os.remove(self.socket_path)
                
            # Create and configure the socket
            logger.info("🔧 Creating Unix domain socket...")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            
            try:
                server.bind(self.socket_path)
                logger.info(f"✅ Socket bound successfully to {self.socket_path}")
            except Exception as e:
                logger.error(f"❌ Failed to bind socket: {str(e)}")
                raise
                
            try:
                os.chmod(self.socket_path, 0o777)
                logger.info("✅ Socket permissions set to 0o777")
            except Exception as e:
                logger.error(f"❌ Failed to set socket permissions: {str(e)}")
                raise
                
            server.listen(1)
            server.settimeout(1.0)
            logger.info("👂 Socket server now listening for connections")
            
            while self.running:
                try:
                    logger.debug("⏳ Waiting for connection...")
                    conn, addr = server.accept()
                    logger.info("🤝 New connection accepted")
                    
                    data = conn.recv(1024).decode().strip()
                    logger.info(f"📥 Received raw data: {data}")
                    
                    if data:
                        try:
                            # Direct test format: "ups@192.168.1.5 ONBATT"
                            if any(event in data for event in [
                                ' ONBATT', ' ONLINE', ' LOWBATT', ' COMMOK', 
                                ' COMMBAD', ' NOCOMM', ' REPLBATT', ' NOPARENT',
                                ' SHUTDOWN'
                            ]):
                                ups, event = data.split(' ', 1)
                            else:
                                # NUT descriptive format: "UPS ups@localhost on battery"
                                if 'on battery' in data:
                                    event = 'ONBATT'
                                elif 'on line' in data:
                                    event = 'ONLINE'
                                elif 'battery low' in data:
                                    event = 'LOWBATT'
                                elif 'communications ok' in data:
                                    event = 'COMMOK'
                                elif 'communications bad' in data:
                                    event = 'COMMBAD'
                                elif 'no communications' in data:
                                    event = 'NOCOMM'
                                elif 'replace battery' in data:
                                    event = 'REPLBATT'
                                elif 'no parent process' in data:
                                    event = 'NOPARENT'
                                elif 'shutting down' in data:
                                    event = 'SHUTDOWN'
                                else:
                                    event = data.split(' ', 1)[1]  # fallback: take everything after "UPS"
                                
                                ups = data.split(' ')[1]  # take the UPS name
                            
                            logger.info(f"✅ Parsed data - UPS: {ups}, Event: {event}")
                            
                            event_data = {
                                'ups': ups,
                                'event': event
                            }
                            
                            logger.info(f"🔄 Forwarding event to handler: {event_data}")
                            
                            # Use the app context to handle the event
                            with self.app.app_context():
                                try:
                                    result = handle_nut_event(self.app, event_data)
                                    logger.info(f"✅ Event handled successfully: {result}")
                                except Exception as e:
                                    logger.error(f"❌ Error in event handler: {str(e)}", exc_info=True)
                                
                        except ValueError as e:
                            logger.error(f"❌ Failed to parse data: {str(e)}")
                            
                    else:
                        logger.warning("⚠️ Received empty data")
                        
                    logger.debug("🔌 Closing connection")
                    conn.close()
                    
                except socket.timeout:
                    logger.debug("⏰ Socket timeout - continuing...")
                    continue
                except Exception as e:
                    logger.error(f"❌ Error in connection handling: {str(e)}", exc_info=True)
                    
        except Exception as e:
            logger.error(f"❌ Fatal socket server error: {str(e)}", exc_info=True)
        finally:
            if os.path.exists(self.socket_path):
                logger.info(f"🧹 Cleaning up socket file: {self.socket_path}")
                os.remove(self.socket_path)
            logger.info("👋 Socket server shutdown complete") 