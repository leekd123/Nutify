import subprocess
from datetime import datetime
import tempfile
import os
from .db_module import (
    db, data_lock, get_ups_data, get_ups_model,
    handle_ups_event, DotDict,
    create_static_model, UPSEvent
)
from cryptography.fernet import Fernet
import base64
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import os
from flask import render_template
from core.settings import (
    MSMTP_PATH,
    TLS_CERT_PATH,
    get_configured_timezone,
    ENCRYPTION_KEY as CONFIG_ENCRYPTION_KEY
)
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from core.logger import mail_logger as logger
logger.info("📨 Initializating mail")

# Encryption key (should be in an environment variable)
ENCRYPTION_KEY = CONFIG_ENCRYPTION_KEY.encode()

# Log of the configured timezone
logger.info(f"🌍 Mail module using timezone: {get_configured_timezone().zone}")

tz = get_configured_timezone()

def get_encryption_key():
    """Generates an encryption key from ENCRYPTION_KEY"""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b'fixed-salt',  # In production, use a secure and unique salt
        iterations=100000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(ENCRYPTION_KEY))
    return Fernet(key)

class MailConfig(db.Model):
    """Model for email configuration"""
    __tablename__ = 'ups_opt_mail_config'
    
    id = db.Column(db.Integer, primary_key=True)
    smtp_server = db.Column(db.String(255), nullable=False)
    smtp_port = db.Column(db.Integer, nullable=False)
    from_name = db.Column(db.String(255), nullable=False)
    from_email = db.Column(db.String(255), nullable=False)
    username = db.Column(db.String(255))
    _password = db.Column('password', db.LargeBinary)
    enabled = db.Column(db.Boolean, default=False)
    provider = db.Column(db.String(50))  # New field for email provider
    tls = db.Column(db.Boolean, default=True)
    tls_starttls = db.Column(db.Boolean, default=True)
    last_test_date = db.Column(db.DateTime)
    last_test_status = db.Column(db.Boolean)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(get_configured_timezone()))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(get_configured_timezone()), onupdate=lambda: datetime.now(get_configured_timezone()))

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        logger.debug(f"📅 Creating MailConfig with timezone: {get_configured_timezone().zone}")
        logger.debug(f"📅 Created at will use: {datetime.now(get_configured_timezone())}")

    @property
    def password(self):
        """Decrypts the password"""
        if self._password is None:
            return None
        f = get_encryption_key()
        return f.decrypt(self._password).decode()

    @password.setter
    def password(self, value):
        """Encrypts the password"""
        if value is None:
            self._password = None
        else:
            f = get_encryption_key()
            self._password = f.encrypt(value.encode())

def get_msmtp_config(config_data):
    """Generate msmtp configuration based on provider and settings"""
    provider = config_data.get('provider', '')
    logger.debug(f"🔧 Generating msmtp config for provider: {provider}")
    logger.debug(f"🔧 SMTP Settings: server={config_data['smtp_server']}, port={config_data['smtp_port']}")
    logger.debug(f"🔧 From: {config_data.get('from_name', '')} <{config_data['from_email']}>")
    logger.debug(f"🔧 Username: {config_data['username']}")
    
    # Base configuration
    config_content = f"""
# Configuration for msmtp
defaults
auth           on
tls            on
tls_trust_file {TLS_CERT_PATH}
logfile        ~/.msmtp.log

account        default
host           {config_data['smtp_server']}
port           {config_data['smtp_port']}
from           {config_data['from_email']}
user           {config_data['username']}
password       {config_data['password']}
"""
    logger.debug(f"📝 Base msmtp config generated with server: {config_data['smtp_server']}:{config_data['smtp_port']}")

    # Provider-specific configurations
    if provider == 'gmail':
        logger.debug("🔒 Adding Gmail-specific TLS configuration: starttls=on")
        config_content += """
tls_starttls   on
"""
    elif provider == 'yahoo':
        logger.debug("🔒 Adding Yahoo-specific TLS configuration: starttls=off")
        config_content += """
tls_starttls   off
"""
    elif provider in ['outlook', 'icloud', 'amazon', 'sendgrid', 'mailgun', 'postmark', 'zoho']:
        logger.debug(f"🔒 Adding {provider}-specific TLS configuration: starttls=on")
        config_content += """
tls_starttls   on
"""
    
    logger.debug("✅ msmtp configuration generated successfully")
    return config_content

def test_email_config(config_data):
    """Tests the email configuration"""
    try:
        logger.info("🔔 Testing Email Notifications...")
        logger.info(f"🕒 Current time with configured timezone: {datetime.now(get_configured_timezone())}")
        logger.debug(f"🔍 Settings timezone: {get_configured_timezone().zone}")
        logger.debug(f"🔍 Current timezone offset: {datetime.now(get_configured_timezone()).strftime('%z')}")
        logger.debug(f"🔍 Full timezone info: UTC{datetime.now(get_configured_timezone()).strftime('%z')} ({get_configured_timezone().zone})")
        
        # Get existing configuration first
        config = MailConfig.query.get(1)
        if not config:
            return False, "No mail configuration found"
            
        # Check if it's a specific notification test
        if config_data.get('test_type') == 'notification':
            event_type = config_data.get('event_type')
            if not event_type:
                return False, "Event type is required for notification test"
                
            # Use the existing test_notification function
            return test_notification(event_type)
        
        # Log test configuration
        logger.debug("📧 Test Configuration:")
        logger.debug(f"📧 Raw config data: {config_data}")
        
        # Get provider from SMTP server if not explicitly provided
        if 'provider' not in config_data:
            if config_data['smtp_server'] == 'smtp.gmail.com':
                config_data['provider'] = 'gmail'
            elif config_data['smtp_server'] == 'smtp.mail.me.com':
                config_data['provider'] = 'icloud'
            elif config_data['smtp_server'] == 'smtp.office365.com':
                config_data['provider'] = 'outlook'
            elif config_data['smtp_server'] == 'smtp.mail.yahoo.com':
                config_data['provider'] = 'yahoo'
            logger.debug(f"📧 Provider determined from SMTP server: {config_data['provider']}")
            
        logger.debug(f"📧 Provider: {config_data['provider']}")
        logger.debug(f"📧 SMTP Server: {config_data['smtp_server']}")
        logger.debug(f"📧 SMTP Port: {config_data['smtp_port']}")
        logger.debug(f"📧 From Name: {config_data['from_name']}")
        logger.debug(f"📧 From Email: {config_data['from_email']}")
        logger.debug(f"📧 Username: {config_data['username']}")
        
        # If the password is not provided, use the saved one
        if 'password' not in config_data or not config_data['password']:
            try:
                logger.debug("🔑 Using existing password from configuration")
                config_data['password'] = config.password
            except Exception as de:
                # If it fails to decrypt the saved password, return an explicit error
                logger.error(f"❌ Failed to decrypt stored password: {str(de)}")
                return False, "Stored password cannot be decrypted with the current encryption key. Please enter a new password."
        
        # Generate msmtp configuration
        config_content = get_msmtp_config(config_data)
        
        # Create temporary configuration file
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            f.write(config_content)
            config_file = f.name
            logger.debug(f"📄 Created temporary config file: {config_file}")
            logger.debug(f"📄 Config file content:\n{config_content}")

        # Create a temporary file for the email content
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            # Get the UPS data from the database
            UPSStaticData = create_static_model()
            ups_static = db.session.query(UPSStaticData).first()
            
            # Render the template with all necessary data
            email_body = render_template('dashboard/mail/test_template.html', 
                ups_model=ups_static.device_model if ups_static else 'Unknown',
                ups_serial=ups_static.device_serial if ups_static else 'Unknown',
                test_date=datetime.now(get_configured_timezone()).strftime('%Y-%m-%d %H:%M:%S'),
                current_year=datetime.now(get_configured_timezone()).year
            )
            
            email_content = f"""Subject: Test Email from UPS Monitor
From: {config_data['from_name']} <{config_data['from_email']}>
To: {config_data['from_email']}
Content-Type: text/html; charset=utf-8

{email_body}
"""
            f.write(email_content)
            email_file = f.name
            logger.debug(f"📄 Created temporary email file: {email_file}")
            logger.debug(f"📄 Email content:\n{email_content}")

        # Send the test email using msmtp
        cmd = [MSMTP_PATH, '-C', config_file, config_data['from_email']]
        logger.debug(f"🚀 Running msmtp command: {' '.join(cmd)}")
        
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        
        with open(email_file, 'rb') as f:
            stdout, stderr = process.communicate(f.read())
        
        # Log msmtp output
        if stdout:
            logger.debug(f"📤 msmtp stdout:\n{stdout.decode()}")
        if stderr:
            logger.debug(f"📥 msmtp stderr:\n{stderr.decode()}")
        
        # Clean up the temporary files
        os.unlink(config_file)
        os.unlink(email_file)
        logger.debug("🧹 Cleaned up temporary files")
        
        if process.returncode == 0:
            logger.info("✅ Test email sent successfully")
            config.last_test_date = datetime.now(get_configured_timezone())
            config.last_test_status = True
            db.session.commit()
            return True, "Test email sent successfully"
        else:
            error = stderr.decode()
            logger.error(f"❌ Failed to send test email: {error}")
            return False, f"Failed to send test email: {error}"
            
    except Exception as e:
        logger.error(f"❌ Error testing email config: {str(e)}", exc_info=True)
        return False, str(e)

def save_mail_config(config_data):
    """Save the email configuration to the database"""
    try:
        # Debug log for incoming data
        logger.debug(f"📨 Received config data: {config_data}")
        logger.debug(f"📨 Provider in config: {config_data.get('provider', 'NOT FOUND')}")
        
        with data_lock:
            config = MailConfig.query.get(1)
            if not config:
                config = MailConfig(id=1)
                db.session.add(config)
            
            # If the "password" field is not provided, check that the saved one is decrypted
            if 'password' not in config_data or not config_data['password']:
                try:
                    _ = config.password  # This will try to decrypt the already-saved password.
                except Exception as de:
                    return False, "Stored password cannot be decrypted with the current encryption key. Please enter a new password."
            
            # Log the provider being saved
            if 'provider' in config_data:
                logger.debug(f"📧 Setting email provider to: {config_data['provider']}")
            
            # Update only allowed fields; handle "password" separately
            allowed_keys = ['smtp_server', 'smtp_port', 'from_name', 'from_email', 'username', 'enabled', 'password', 'provider', 'tls', 'tls_starttls']
            for key in allowed_keys:
                if key in config_data:
                    value = config_data[key]
                    if key == 'password':
                        if not value:  # If no new password is provided, leave the existing one.
                            continue
                        config.password = value  # Use the setter to encrypt the new password.
                    elif key == 'smtp_port':
                        try:
                            config.smtp_port = int(value)
                        except ValueError:
                            config.smtp_port = None
                    else:
                        setattr(config, key, value)
                        if key == 'provider':
                            logger.debug(f"📧 Provider saved in database: {value}")
            
            # Debug log before commit
            logger.debug(f"📧 Final provider value before commit: {config.provider}")
            
            db.session.commit()
            
            # Debug log after commit
            logger.debug(f"📧 Provider value after commit: {config.provider}")
            logger.info("✅ Mail configuration saved successfully")
            return True, None
    except Exception as e:
        db.session.rollback()
        logger.error("❌ Failed to save mail config:", exc_info=True)
        return False, str(e)

def send_email(to_addr, subject, html_content, smtp_settings, attachments=None):
    """Send email with proper subject handling and attachments support"""
    try:
        # Ensure the subject is a clean string
        clean_subject = str(subject).strip()
        logger.debug(f"📧 Sending email to: {to_addr}")
        logger.debug(f"📧 Subject: {clean_subject}")
        
        # Create email message
        msg = MIMEMultipart('related')
        msg['Subject'] = clean_subject
        msg['From'] = f"{smtp_settings.get('from_name', 'UPS Monitor')} <{smtp_settings['from_addr']}>"
        msg['To'] = to_addr if isinstance(to_addr, str) else ", ".join(to_addr)
        
        # Add HTML content first
        html_part = MIMEText(html_content, 'html')
        msg.attach(html_part)
        
        # Add attachments if any
        if attachments:
            for attachment in attachments:
                # Create image from binary data
                img = MIMEImage(attachment['data'])
                img.add_header('Content-ID', f"<{attachment['cid']}>")
                img.add_header('Content-Disposition', 'inline', filename=attachment['name'])
                msg.attach(img)
        
        # Generate msmtp configuration
        config_content = get_msmtp_config({
            'smtp_server': smtp_settings['host'],
            'smtp_port': smtp_settings['port'],
            'from_email': smtp_settings['from_addr'],
            'username': smtp_settings['username'],
            'password': smtp_settings['password'],
            'provider': smtp_settings.get('provider', '')
        })
        
        # Create temporary configuration file
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            f.write(config_content)
            config_file = f.name
            logger.debug(f"📄 Created temporary config file: {config_file}")

        # Write the complete email to a temporary file
        with tempfile.NamedTemporaryFile(mode='w', delete=False) as f:
            f.write(msg.as_string())
            email_file = f.name
            logger.debug(f"📄 Created temporary email file: {email_file}")

        # Send email using msmtp
        cmd = [MSMTP_PATH, '-C', config_file]
        if isinstance(to_addr, list):
            cmd.extend(to_addr)
        else:
            cmd.append(to_addr)
            
        logger.debug(f"🚀 Running msmtp command: {' '.join(cmd)}")

        with open(email_file, 'rb') as f:
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            stdout, stderr = process.communicate(f.read())

        # Clean up temporary files
        os.unlink(config_file)
        os.unlink(email_file)
        logger.debug("🧹 Cleaned up temporary files")

        if process.returncode == 0:
            logger.info("✅ Email sent successfully")
            return True, "Email sent successfully"
        else:
            error = stderr.decode() if stderr else "Unknown error"
            logger.error(f"❌ Failed to send email: {error}")
            return False, f"Failed to send email: {error}"
            
    except Exception as e:
        logger.error(f"❌ Error sending email: {str(e)}", exc_info=True)
        raise

class EmailNotifier:
    TEMPLATE_MAP = {
        'ONLINE': 'mail/online_notification.html',
        'ONBATT': 'mail/onbatt_notification.html',
        'LOWBATT': 'mail/lowbatt_notification.html',
        'COMMOK': 'mail/commok_notification.html',
        'COMMBAD': 'mail/commbad_notification.html',
        'SHUTDOWN': 'mail/shutdown_notification.html',
        'REPLBATT': 'mail/replbatt_notification.html',
        'NOCOMM': 'mail/nocomm_notification.html',
        'NOPARENT': 'mail/noparent_notification.html'
    }

    @staticmethod
    def should_notify(event_type):
        """Check if an event type should be notified"""
        try:
            setting = NotificationSettings.query.filter_by(event_type=event_type).first()
            return setting and setting.enabled
        except Exception as e:
            logger.error(f"Error checking notification settings: {e}")
            return False

    @staticmethod
    def get_template_data(event_type, ups_name):
        """
        Get the template data using existing APIs
        Args:
            event_type: Event type (ONBATT, ONLINE, etc)
            ups_name: UPS name
        Returns:
            dict: Formatted data for the template
        """
        try:
            ups_data = get_ups_data()
            if not ups_data:
                logger.error("Failed to get UPS data")
                return {}
            
            # Base data common to all templates
            now = datetime.now(get_configured_timezone())
            logger.info(f"📧 Preparing email with timezone {get_configured_timezone().zone}, time: {now}")
            base_data = {
                'event_date': now.strftime('%Y-%m-%d'),
                'event_time': now.strftime('%H:%M:%S'),
                'ups_model': ups_data.device_model,
                'ups_host': ups_name,
                'ups_status': ups_data.ups_status,
                'current_year': now.year,
                'is_test': False
            }
            
            # Add specific data based on the event type
            if event_type in ['ONBATT', 'ONLINE', 'LOWBATT', 'SHUTDOWN']:
                base_data.update({
                    'battery_charge': f"{ups_data.battery_charge:.1f}%" if ups_data.battery_charge else "N/A",
                    'input_voltage': f"{ups_data.input_voltage:.1f}V" if ups_data.input_voltage else "N/A",
                    'battery_voltage': f"{ups_data.battery_voltage:.1f}V" if ups_data.battery_voltage else "N/A",
                    'runtime_estimate': format_runtime(ups_data.battery_runtime),
                    'battery_duration': get_battery_duration()
                })
            
            if event_type == 'REPLBATT':
                base_data.update({
                    'battery_age': get_battery_age(),
                    'battery_efficiency': calculate_battery_efficiency(),
                    'battery_capacity': f"{ups_data.battery_charge:.1f}%" if ups_data.battery_charge else "N/A",
                    'battery_voltage': f"{ups_data.battery_voltage:.1f}V" if ups_data.battery_voltage else "N/A"
                })
            
            if event_type in ['NOCOMM', 'COMMBAD', 'COMMOK']:
                base_data.update({
                    'last_known_status': get_last_known_status(),
                    'comm_duration': get_comm_duration()
                })
                # Add battery data only for COMMOK
                if event_type == 'COMMOK':
                    base_data.update({
                        'battery_charge': f"{ups_data.battery_charge:.1f}%" if ups_data.battery_charge else "N/A",
                        'battery_voltage': f"{ups_data.battery_voltage:.1f}V" if ups_data.battery_voltage else "N/A"
                    })
            
            logger.debug(f"Template data prepared for {event_type}: {base_data}")
            return base_data
        
        except Exception as e:
            logger.error(f"Error preparing template data: {str(e)}")
            return {}

    @staticmethod
    def send_notification(event_type: str, event_data: dict) -> tuple[bool, str]:
        """Send email notification for UPS event"""
        try:
            logger.info(f"📅 Sending scheduled report...")
            logger.debug(f"🔍 Scheduler using timezone: {get_configured_timezone().zone}")
            logger.info(f"Sending notification for event type: {event_type}")
            
            # Check that event_data is a dictionary
            if isinstance(event_data, dict):
                data_for_template = event_data
            else:
                # If it's not a dictionary, try to convert it
                data_for_template = event_data.to_dict() if hasattr(event_data, "to_dict") else {
                    k: v for k, v in event_data.__dict__.items() 
                    if not k.startswith('_')
                } if hasattr(event_data, "__dict__") else {}

            logger.debug(f"Template data prepared for {event_type}: {data_for_template}")

            # Get notification settings
            notification_settings = NotificationSettings.query.filter_by(event_type=event_type).first()
            if not notification_settings:
                logger.warning("No notification settings found")
                return False, "No notification settings found"

            # Ignore enabled check if it's a test
            if not notification_settings.enabled and not data_for_template.get('is_test', False):
                logger.info("Notifications are disabled")
                return False, "Notifications are disabled"

            # Check if this event type should be notified
            event_enabled = getattr(notification_settings, f"notify_{event_type.lower()}", True)
            if not event_enabled and not data_for_template.get('is_test', False):
                logger.info(f"Notifications for {event_type} are disabled")
                return False, f"Notifications for {event_type} are disabled"

            # Get mail configuration from MailConfig
            mail_config = MailConfig.query.get(1)
            if not mail_config or not mail_config.enabled:
                logger.info("Email configuration not found or disabled")
                return False, "Email configuration not found or disabled"

            # List of providers that have issues with base64 inline images and modern CSS
            problematic_providers = ['gmail', 'yahoo', 'outlook', 'office365']
            provider = mail_config.provider.lower() if mail_config.provider else ''
            
            # Add is_problematic_provider to template data
            data_for_template['is_problematic_provider'] = provider in problematic_providers
            
            # Get email template
            template = EmailNotifier.TEMPLATE_MAP.get(event_type)
            if not template:
                logger.error(f"No template found for event type: {event_type}")
                return False, f"No template found for event type: {event_type}"

            # Adjust template path
            if not template.startswith("dashboard/"):
                template = f"dashboard/{template}"

            # Add current year to template data
            data_for_template['current_year'] = datetime.now().year
            
            # Render template
            try:
                html_content = render_template(template, **data_for_template)
            except Exception as e:
                logger.error(f"Error rendering template: {str(e)}")
                return False, f"Error rendering template: {template}"

            # Send email
            success, message = send_email(
                to_addr=[mail_config.from_email],
                subject=f"UPS Event: {event_type}",
                html_content=html_content,
                smtp_settings={
                    'host': mail_config.smtp_server,
                    'port': mail_config.smtp_port,
                    'username': mail_config.username,
                    'password': mail_config.password,
                    'use_tls': True,
                    'from_addr': mail_config.from_email,
                    'from_name': mail_config.from_name,
                    'provider': mail_config.provider
                }
            )

            return success, message

        except Exception as e:
            logger.error(f"Error sending notification: {str(e)}")
            return False, str(e)

def handle_notification(event_data):
    """
    Handles the email notification for an UPS event
    Args:
        event_data: Dict containing event data (ups, event)
    """
    try:
        event_type = event_data.get('event')
        ups = event_data.get('ups')
        
        logger.info(f"Processing notification for event {event_type} from UPS {ups}")
        
        # Check if notifications are enabled for this event
        notify_setting = NotificationSettings.query.filter_by(event_type=event_type).first()
        if not notify_setting or not notify_setting.enabled:
            logger.info(f"Notifications disabled for event type: {event_type}")
            return
            
        # Get the email configuration
        mail_config = MailConfig.query.get(1)
        if not mail_config or not mail_config.enabled:
            logger.info("Email configuration not found or disabled")
            return
            
        # Get the template data using existing APIs
        notification_data = EmailNotifier.get_template_data(event_type, ups)
        if not notification_data:
            logger.error("Failed to get template data")
            return
            
        # Send the notification using the correct template
        success, message = EmailNotifier.send_notification(
            event_type,
            notification_data  # Removed the template parameter
        )
        
        if not success:
            logger.error(f"Failed to send notification: {message}")
            return
            
        logger.info("Notification sent successfully")
        
    except Exception as e:
        logger.error(f"Error handling notification: {str(e)}", exc_info=True)

def init_notification_settings():
    """Initialize notification settings"""
    try:
        # Ensure all tables exist
        db.create_all()
        
        # Initialize mail config if it doesn't exist
        mail_config = MailConfig.query.get(1)
        if not mail_config:
            mail_config = MailConfig(
                id=1,
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
            db.session.add(mail_config)
            db.session.commit()
            logger.info("Created default mail configuration")
            
        # Initialize notifications
        settings = NotificationSettings.query.all()
        if not settings:
            for event_type in EmailNotifier.TEMPLATE_MAP.keys():
                setting = NotificationSettings(event_type=event_type, enabled=False)
                db.session.add(setting)
            db.session.commit()
            logger.info("Notification settings initialized")
            
    except Exception as e:
        logger.error(f"Error initializing notification settings: {str(e)}")
        db.session.rollback()

def get_notification_settings():
    """Get all notification settings"""
    return NotificationSettings.query.all() 

def test_notification(event_type):
    """
    Function to test email notifications with simulated data
    Args:
        event_type: Event type to test
    Returns:
        tuple: (success, message)
    """
    try:
        # Get real UPS data first
        ups_data = get_ups_data() or {}
        
        # Base data common to all events
        base_data = {
            'device_model': getattr(ups_data, 'device_model', 'Back-UPS RS 1600SI'),
            'device_serial': getattr(ups_data, 'device_serial', 'Unknown'),
            'ups_status': getattr(ups_data, 'ups_status', 'OL'),
            'battery_charge': getattr(ups_data, 'battery_charge', '100'),
            'battery_voltage': getattr(ups_data, 'battery_voltage', '13.2'),
            'battery_runtime': getattr(ups_data, 'battery_runtime', '2400'),
            'input_voltage': getattr(ups_data, 'input_voltage', '230.0'),
            'ups_load': getattr(ups_data, 'ups_load', '35'),
            'ups_realpower': getattr(ups_data, 'ups_realpower', '180'),
            'ups_temperature': getattr(ups_data, 'ups_temperature', '32.5'),
            # Add a flag to indicate that it's a test
            'is_test': True,
            'event_date': datetime.now(get_configured_timezone()).strftime('%Y-%m-%d'),
            'event_time': datetime.now(get_configured_timezone()).strftime('%H:%M:%S'),
            'battery_duration': get_battery_duration()
        }

        # Specific data for event type
        event_specific_data = {
            'ONLINE': {
                'ups_status': 'OL',
                'battery_runtime': '300',
                'input_voltage': '230.0',
                'input_transfer_reason': 'Utility power restored'
            },
            'ONBATT': {
                'ups_status': 'OB',
                'input_voltage': '0.0',
                'battery_runtime': '1800',
                'input_transfer_reason': 'Line power fail'
            },
            'LOWBATT': {
                'ups_status': 'OB LB',
                'battery_charge': '10',
                'battery_runtime': '180',
                'battery_runtime': '1200',
                'input_voltage': '0.0'
            },
            'COMMOK': {
                'ups_status': 'OL',
                'input_transfer_reason': 'Communication restored'
            },
            'COMMBAD': {
                'ups_status': 'OL COMMOK',
                'input_transfer_reason': 'Communication failure'
            },
            'SHUTDOWN': {
                'ups_status': 'OB LB',
                'battery_charge': '5',
                'battery_runtime': '60',
                'battery_runtime': '1500',
                'ups_timer_shutdown': '30',
                'input_voltage': '0.0'
            },
            'REPLBATT': {
                'ups_status': 'OL RB',
                'battery_date': '2020-01-01',
                'battery_mfr_date': '2020-01-01',
                'battery_type': 'Li-ion',
                'battery_voltage_nominal': '12.0'
            },
            'NOCOMM': {
                'ups_status': 'OL COMMOK',
                'input_transfer_reason': 'Communication lost'
            },
            'NOPARENT': {
                'ups_status': 'OL',
                'input_transfer_reason': 'Process terminated'
            }
        }

        # Combine base data with specific event data
        test_data = base_data.copy()
        if event_type in event_specific_data:
            test_data.update(event_specific_data[event_type])

        # Create a DotDict object with test data
        test_data_obj = DotDict(test_data)
            
        # Use the existing handle_notification function to send the test email
        success, message = EmailNotifier.send_notification(event_type, test_data_obj)
        
        return success, message

    except Exception as e:
        logger.error(f"Error testing notification: {str(e)}")
        return False, str(e) 

def test_notification_settings():
    """Test the email settings by sending a test email"""
    try:
        logger.info("📊 Testing Report Settings...")
        ups_data = get_ups_data() or {}
        test_data = {
            'ups_model': get_ups_model(),
            'ups_serial': ups_data.device_serial if ups_data else 'Unknown',
            'test_date': datetime.now(get_configured_timezone()).strftime('%Y-%m-%d %H:%M:%S'),
            'current_year': datetime.now(get_configured_timezone()).year
        }
        logger.debug(f"🔍 Report will use timezone: {get_configured_timezone().zone}")
        
        # Use the HTML template for the test
        template = 'dashboard/mail/test_template.html'
        
        # Send the test email using the template
        success, message = EmailNotifier.send_notification(
            subject="UPS Monitor - Test Email",
            template=template,
            data=test_data
        )
        
        if success:
            # Update the test status
            with data_lock:
                mail_config = MailConfig.query.get(1)
                if mail_config:
                    mail_config.last_test_date = datetime.now(get_configured_timezone())
                    mail_config.last_test_status = True
                    db.session.commit()
        
        return success, message

    except Exception as e:
        logger.error(f"Error testing notification: {str(e)}")
        return False, str(e) 

def format_runtime(seconds):
    """Format the runtime in a readable format"""
    try:
        if not seconds:
            return "N/A"
            
        seconds = float(seconds)
        if seconds < 60:
            return f"{int(seconds)} sec"
            
        minutes = int(seconds / 60)
        if minutes < 60:
            return f"{minutes} min"
            
        hours = minutes // 60
        mins = minutes % 60
        return f"{hours}h {mins}m"
    except Exception as e:
        logger.error(f"Error formatting runtime: {str(e)}")
        return "N/A"

def get_battery_duration():
    """Calculate the time passed since the last battery event"""
    try:
        # For ONLINE, find the last complete ONBATT->ONLINE cycle
        last_online = UPSEvent.query.filter(
            UPSEvent.event_type == 'ONLINE'
        ).order_by(UPSEvent.timestamp_tz.desc()).first()
        
        if last_online:
            # Find the ONBATT that precedes this ONLINE
            last_onbatt = UPSEvent.query.filter(
                UPSEvent.event_type == 'ONBATT',
                UPSEvent.timestamp_tz < last_online.timestamp_tz
            ).order_by(UPSEvent.timestamp_tz.desc()).first()
            
            if last_onbatt:
                duration = last_online.timestamp_tz - last_onbatt.timestamp_tz
                seconds = duration.total_seconds()
                if seconds < 60:
                    return f"{int(seconds)} sec"
                minutes = int(seconds / 60)
                return f"{minutes} min"
        
        return "N/A"
    except Exception as e:
        logger.error(f"Error calculating battery duration: {str(e)}")
        return "N/A"

def get_last_known_status():
    """Get the last known UPS status"""
    try:
        ups_data = get_ups_data()
        if ups_data and ups_data.ups_status:
            return ups_data.ups_status
            
        # Fallback on events if get_ups_data doesn't have the status
        last_event = UPSEvent.query.order_by(UPSEvent.timestamp_tz.desc()).first()
        if last_event and last_event.ups_status:
            return last_event.ups_status
            
        return "Unknown"
    except Exception as e:
        logger.error(f"Error getting last known status: {str(e)}")
        return "Unknown"

def get_comm_duration():
    """Calculate the duration of the communication interruption"""
    try:
        # Find the last COMMBAD/NOCOMM event
        last_comm_fail = UPSEvent.query.filter(
            UPSEvent.event_type.in_(['COMMBAD', 'NOCOMM'])
        ).order_by(UPSEvent.timestamp_tz.desc()).first()
        
        if last_comm_fail:
            # Calculate the duration until the current event
            now = datetime.now(get_configured_timezone())
            duration = now - last_comm_fail.timestamp_tz
            seconds = duration.total_seconds()
            
            if seconds < 60:
                return f"{int(seconds)} sec"
            minutes = int(seconds / 60)
            return f"{minutes} min"
        
        return "N/A"
    except Exception as e:
        logger.error(f"Error calculating comm duration: {str(e)}")
        return "N/A"

def get_battery_age():
    """Calculate the battery age"""
    try:
        ups_data = get_ups_data()
        if ups_data and ups_data.battery_mfr_date:  # Use battery_mfr_date instead of battery_date
            try:
                install_date = datetime.strptime(ups_data.battery_mfr_date, '%Y/%m/%d')
                age = datetime.now(get_configured_timezone()) - install_date
                return f"{age.days // 365} years and {(age.days % 365) // 30} months"
            except ValueError as e:
                logger.error(f"Error parsing battery date: {str(e)}")
                return "N/A"
    except Exception as e:
        logger.error(f"Error calculating battery age: {str(e)}")
    return "N/A"

def calculate_battery_efficiency():
    """Calculate the battery efficiency based on runtime"""
    try:
        ups_data = get_ups_data()
        if ups_data:
            # Calculate the efficiency based on runtime and current charge
            runtime = float(ups_data.battery_runtime or 0)
            charge = float(ups_data.battery_charge or 0)
            
            # A new UPS should have about 30-45 minutes of runtime at 100% charge
            nominal_runtime = 2700  # 45 minutes in seconds
            
            if charge > 0:
                # Normalize the runtime to 100% charge
                normalized_runtime = (runtime / charge) * 100
                efficiency = (normalized_runtime / nominal_runtime) * 100
                return f"{min(100, efficiency):.1f}%"
    except Exception as e:
        logger.error(f"Error calculating battery efficiency: {str(e)}")
    return "N/A" 

class NotificationSettings(db.Model):
    """Model for notification settings"""
    __tablename__ = 'ups_opt_notification'
    
    id = db.Column(db.Integer, primary_key=True)
    event_type = db.Column(db.String(50), unique=True, nullable=False)
    enabled = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(get_configured_timezone()))
    updated_at = db.Column(db.DateTime(timezone=True), default=lambda: datetime.now(get_configured_timezone()), onupdate=lambda: datetime.now(get_configured_timezone())) 