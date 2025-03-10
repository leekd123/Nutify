import schedule
import threading
import time
from datetime import datetime, timedelta
import pytz
from core.logger import get_logger
from core.settings import get_configured_timezone, parse_time_format
from core.db_module import db, ReportSchedule
from core.mail import MailConfig
from email_validator import validate_email, EmailNotValidError
from tenacity import retry, stop_after_attempt, wait_exponential
from typing import List, Optional
from flask import request, jsonify
from core.report import get_current_email_settings

scheduler_logger = get_logger('scheduler')

class Scheduler:
    def __init__(self, app=None):
        """Initialize the scheduler"""
        self.app = app
        self.tz = get_configured_timezone()
        self.scheduler_lock = threading.Lock()
        self.last_schedule_id = None
        self.report_manager = None 
        if app:
            self.init_app(app)

    def init_app(self, app):
        """Initialize scheduler with Flask app"""
        try:
            self.app = app
            scheduler_logger.info("📅 Initializing Scheduler")
            
            # Import report_manager here to avoid circular import
            from core.report import report_manager
            self.report_manager = report_manager
            
            with app.app_context():
                # Load active schedules from database
                schedules = ReportSchedule.query.filter_by(enabled=True).all()
                scheduler_logger.info(f"Found {len(schedules)} enabled schedules")
                
                # Add jobs using schedule library
                for sched_item in schedules:
                    self._add_job_from_schedule(sched_item)
                
                # Start scheduler thread
                self.start_scheduler()
                
        except Exception as e:
            scheduler_logger.error(f"Error in init_app: {str(e)}", exc_info=True)

    def _add_job_from_schedule(self, schedule_item):
        """Add a scheduled job based on database configuration"""
        try:
            # Skip if schedule is disabled
            if not schedule_item.enabled:
                scheduler_logger.info(f"Schedule {schedule_item.id} is disabled, skipping")
                return True

            # Clear existing jobs for this schedule
            self.clear_jobs_for_schedule(schedule_item.id)
            
            # Parse time format
            time_str = schedule_item.time
            if not validate_time_format(time_str):
                scheduler_logger.error(f"Invalid time format: {time_str}")
                return False

            days_str = schedule_item.days.strip()

            if days_str == "*" or days_str == "":
                # Schedule daily job
                job = schedule.every().day.at(time_str).do(
                    self._wrapped_generate_report,
                    schedule_item.reports.split(','),
                    schedule_item.email,
                    schedule_item.period_type
                )
                job.tag(f"schedule_{schedule_item.id}")
                scheduler_logger.info(f"Added daily job at {time_str}")
            else:
                # Schedule for specific days
                day_mapping = {
                    0: "sunday", 1: "monday", 2: "tuesday",
                    3: "wednesday", 4: "thursday", 5: "friday",
                    6: "saturday"
                }
                day_list = [int(d) for d in days_str.split(',') if d.strip().isdigit()]
                for d in day_list:
                    if d in day_mapping:
                        job = getattr(schedule.every(), day_mapping[d]).at(time_str).do(
                            self._wrapped_generate_report,
                            schedule_item.reports.split(','),
                            schedule_item.email,
                            schedule_item.period_type
                        )
                        job.tag(f"schedule_{schedule_item.id}")
                        scheduler_logger.info(f"Added job for {day_mapping[d]} at {time_str}")
            return True
        except Exception as e:
            scheduler_logger.error(f"Error adding job: {str(e)}")
            return False

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    def _wrapped_generate_report(self, report_types, email, period_type='daily'):
        """Wrapper to run report generation within app context"""
        try:
            with self.app.app_context():
                # Verify schedule is still enabled
                # If report_types is a string, convert it to a list
                if isinstance(report_types, str):
                    report_types_str = report_types
                    report_types = [rt.strip() for rt in report_types.split(',')]
                else:
                    report_types_str = ','.join(report_types)
                    
                schedule = ReportSchedule.query.filter_by(
                    enabled=True,
                    reports=report_types_str,
                    email=email,
                    period_type=period_type
                ).first()
                
                if not schedule:
                    scheduler_logger.info("Schedule disabled or not found, skipping")
                    return False

                # Verify email notifications are enabled
                mail_config = MailConfig.query.first()
                if not mail_config or not mail_config.enabled:
                    scheduler_logger.warning("❌ Email notifications disabled")
                    return False

                with self.app.test_request_context():
                    scheduler_logger.info("="*50)
                    scheduler_logger.info("EXECUTING SCHEDULED REPORT")
                    scheduler_logger.info(f"Types: {report_types}")
                    scheduler_logger.info(f"Email: {email}")
                    scheduler_logger.info(f"Period: {period_type}")

                    # Calculate dates based on period_type
                    from_date, to_date, period_unit = calculate_report_period(period_type)
                    scheduler_logger.info(f"Date range: {from_date} to {to_date}")
                    
                    # Ensure dates have timezone
                    tz = get_configured_timezone()
                    if from_date and from_date.tzinfo is None:
                        from_date = tz.localize(from_date)
                    if to_date and to_date.tzinfo is None:
                        to_date = tz.localize(to_date)
                    
                    # Normalize report types
                    valid_types = ['energy', 'battery', 'power', 'voltage', 'events']
                    report_types = [rt for rt in report_types if rt in valid_types]
                    
                    if not report_types:
                        scheduler_logger.error("❌ No valid report types")
                        return False

                    success = self.report_manager.generate_and_send_report(
                        report_types=report_types,
                        email=email,
                        from_date=from_date,
                        to_date=to_date,
                        period_type=period_type
                    )

                    scheduler_logger.info("✅ Report sent" if success else "❌ Report failed")
                    scheduler_logger.info("="*50)
                    return success

        except Exception as e:
            scheduler_logger.error(f"Error in scheduled report: {str(e)}", exc_info=True)
            return False

    def start_scheduler(self):
        """Start background thread for scheduler"""
        def run_scheduler():
            while True:
                schedule.run_pending()
                time.sleep(1)

        t = threading.Thread(target=run_scheduler)
        t.daemon = True
        t.start()
        scheduler_logger.info("✅ Scheduler thread started")

    def clear_jobs_for_schedule(self, schedule_id):
        """Remove all jobs for a specific schedule"""
        try:
            scheduler_logger.info(f"Clearing jobs for schedule {schedule_id}")
            tag = f"schedule_{schedule_id}"
            schedule.clear(tag)
            scheduler_logger.info(f"Cleared jobs for schedule {schedule_id}")
            return True
        except Exception as e:
            scheduler_logger.error(f"Error clearing jobs: {str(e)}")
            return False

    def get_scheduled_jobs(self):
        """Get list of all scheduled jobs"""
        try:
            jobs = schedule.jobs
            scheduler_logger.info(f"Current scheduled jobs ({len(jobs)}):")
            for job in jobs:
                scheduler_logger.info(f"- {job}")
            return jobs
        except Exception as e:
            scheduler_logger.error(f"Error getting jobs: {str(e)}")
            return []

    def validate_emails(self, emails: List[str]) -> List[str]:
        """Validate email addresses"""
        valid_emails = []
        for email in emails:
            try:
                valid = validate_email(email.strip())
                valid_emails.append(valid.email)
            except EmailNotValidError as e:
                scheduler_logger.warning(f"Invalid email: {email} - {str(e)}")
        return valid_emails

    def schedule_report(self, cron_expression, report_types, email, period_type='daily'):
        """Schedule a new report"""
        with self.scheduler_lock:
            try:
                scheduler_logger.info("="*50)
                scheduler_logger.info(f"SCHEDULING NEW REPORT - Time: {cron_expression}, Types: {report_types}")
                
                # Convert cron time format (MM HH * * D) to HH:MM format
                parts = cron_expression.split()
                if len(parts) >= 2:
                    time_str = f"{parts[1].zfill(2)}:{parts[0].zfill(2)}"  # Convert "5 11 * * 0" to "11:05"
                    days_str = parts[4] if len(parts) > 4 else "*"
                else:
                    time_str = cron_expression  # Keep as is if not in cron format
                    days_str = "*"
                
                # Create a new schedule record in the database
                new_schedule = ReportSchedule(
                    time=time_str,
                    days=days_str,
                    reports=",".join(report_types) if isinstance(report_types, list) else report_types,
                    email=email,
                    period_type=period_type,
                    enabled=True
                )
                
                # If period_type is 'range', save also from_date and to_date
                if period_type == 'range':
                    try:
                        tz = get_configured_timezone()
                        from_date = datetime.strptime(parts[5], '%Y-%m-%d')
                        to_date = datetime.strptime(parts[6], '%Y-%m-%d')
                        # Add timezone if missing
                        if from_date.tzinfo is None:
                            from_date = tz.localize(from_date)
                        if to_date.tzinfo is None:
                            to_date = tz.localize(to_date)
                        new_schedule.from_date = from_date
                        new_schedule.to_date = to_date
                    except Exception as e:
                        scheduler_logger.error(f"Error parsing dates for range: {e}")
                        return jsonify({
                            'success': False,
                            'message': f'Invalid date format: {str(e)}'
                        }), 400
                
                db.session.add(new_schedule)
                db.session.commit()
                self.last_schedule_id = new_schedule.id  # Store the ID
                
                # Add the job using the schedule library
                success = self._add_job_from_schedule(new_schedule)
                
                if success:
                    scheduler_logger.info(f"✅ Report scheduled successfully with ID: {new_schedule.id}")
                    return True
                else:
                    scheduler_logger.error("❌ Failed to schedule report - Rolling back...")
                    db.session.delete(new_schedule)
                    db.session.commit()
                    return False
                    
            except Exception as e:
                scheduler_logger.error(f"Error scheduling report: {str(e)}")
                db.session.rollback()
                return False

    def _execute_scheduled_report(self, schedule_id):
        """Execute a scheduled report"""
        try:
            with self.app.app_context():
                schedule_item = ReportSchedule.query.get(schedule_id)
                if not schedule_item or not schedule_item.enabled:
                    return

                # For 'range', use from_date and to_date from the schedule
                if schedule_item.period_type == 'range':
                    if not hasattr(schedule_item, 'from_date') or not hasattr(schedule_item, 'to_date'):
                        scheduler_logger.error(f"Schedule {schedule_id} has period_type 'range' but is missing from_date or to_date")
                        return
                    
                    if not schedule_item.from_date or not schedule_item.to_date:
                        scheduler_logger.error(f"Schedule {schedule_id} has period_type 'range' but from_date or to_date is None")
                        return
                    
                    # The dates are already in datetime format with timezone
                    from_date = schedule_item.from_date
                    to_date = schedule_item.to_date
                    
                    # Determine if it's a 'hrs' or 'days' period
                    period_unit = 'hrs' if from_date.date() == to_date.date() else 'days'
                    
                    scheduler_logger.info(f"Range schedule: from {from_date} to {to_date}, unit: {period_unit}")
                else:
                    # For other types, use the existing function
                    from_date, to_date, period_unit = calculate_report_period(schedule_item.period_type)

                scheduler_logger.info(f"📧 Sending scheduled report from {from_date} to {to_date}")
                scheduler_logger.info(f"Period type: {schedule_item.period_type}")

                # Ensure dates have timezone
                tz = get_configured_timezone()
                if from_date and from_date.tzinfo is None:
                    from_date = tz.localize(from_date)
                if to_date and to_date.tzinfo is None:
                    to_date = tz.localize(to_date)

                success = self.report_manager.generate_and_send_report(
                    report_types=schedule_item.reports.split(','),
                    email=schedule_item.email,
                    from_date=from_date,
                    to_date=to_date,
                    period_type=schedule_item.period_type
                )

                if success:
                    scheduler_logger.info(f"Report sent successfully for schedule {schedule_id}")
                else:
                    scheduler_logger.error(f"Failed to send report for schedule {schedule_id}")

        except Exception as e:
            scheduler_logger.error(f"Error executing schedule {schedule_id}: {str(e)}")

def calculate_report_period(period_type):
    """Calculate start and end dates based on period type"""
    tz = get_configured_timezone()
    now = datetime.now(tz)

    if period_type == 'yesterday':
        # Yesterday from 00:00 to 24:00
        start_date = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date.replace(hour=23, minute=59, second=59)
        return start_date, end_date, 'hrs'

    elif period_type == 'last_week':
        # Find Monday of last week
        days_since_monday = now.weekday() + 7  # +7 to go to the previous week
        start_date = (now - timedelta(days=days_since_monday)).replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = (start_date + timedelta(days=6)).replace(hour=23, minute=59, second=59)
        return start_date, end_date, 'days'

    elif period_type == 'last_month':
        # First day of last month
        first_day = (now.replace(day=1) - timedelta(days=1)).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # Last day of last month
        last_day = now.replace(day=1) - timedelta(days=1)
        end_date = last_day.replace(hour=23, minute=59, second=59)
        return first_day, end_date, 'days'

    elif period_type == 'range':
        # For custom range, dates will be passed separately
        return None, None, None

    # Default a yesterday
    start_date = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    end_date = start_date.replace(hour=23, minute=59, second=59)
    return start_date, end_date, 'hrs'

def validate_time_format(time_str):
    """Validate that the time string is in the correct format"""
    try:
        # Use the parse_time_format function to validate the time
        parse_time_format(time_str)
        return True
    except Exception:
        return False

# Global scheduler instance
scheduler = Scheduler()

def register_scheduler_routes(app):
    """Register all scheduler-related routes"""
    
    @app.route('/api/settings/report/schedules', methods=['GET', 'POST'])
    @app.route('/api/settings/report/schedules/<int:schedule_id>', methods=['PUT', 'DELETE'])
    def handle_report_schedules(schedule_id=None):
        """Handle report schedules operations"""
        try:
            scheduler_logger.info(f"📅 Handling report schedules request: {request.method}")
            
            if request.method == 'POST':
                data = request.get_json()
                scheduler_logger.info(f"📤 Creating new schedule with data: {data}")
                
                # Validate fields
                if not all(k in data for k in ['reports', 'period_type']):
                    return jsonify({
                        'success': False,
                        'message': 'Missing required fields'
                    }), 400

                # If period_type is 'range', verify that from_date and to_date are present
                if data.get('period_type') == 'range' and (not data.get('from_date') or not data.get('to_date')):
                    return jsonify({
                        'success': False,
                        'message': 'From and To dates required for range period'
                    }), 400

                # If time is empty, use a default value
                time_str = data.get('time', '00:00')
                if not time_str:
                    time_str = '00:00'

                # Split time in safety
                hour, minute = time_str.split(':')
                
                # Convert to cron expression
                days_str = ','.join(str(d) for d in data.get('days', [])) or '*'
                cron_expr = f"{minute} {hour} * * {days_str}"

                # Create new schedule in the database
                new_schedule = ReportSchedule(
                    time=time_str,
                    days=days_str,
                    reports=",".join(data['reports']) if isinstance(data['reports'], list) else data['reports'],
                    email=data.get('email') or get_current_email_settings(),
                    period_type=data['period_type'],
                    enabled=True
                )
                
                # If period_type is 'range', save also from_date and to_date
                if data.get('period_type') == 'range':
                    try:
                        tz = get_configured_timezone()
                        from_date = datetime.strptime(data.get('from_date'), '%Y-%m-%d')
                        to_date = datetime.strptime(data.get('to_date'), '%Y-%m-%d')
                        # Add timezone if missing
                        if from_date.tzinfo is None:
                            from_date = tz.localize(from_date)
                        if to_date.tzinfo is None:
                            to_date = tz.localize(to_date)
                        new_schedule.from_date = from_date
                        new_schedule.to_date = to_date
                    except Exception as e:
                        scheduler_logger.error(f"Error parsing dates for range: {e}")
                        return jsonify({
                            'success': False,
                            'message': f'Invalid date format: {str(e)}'
                        }), 400
                
                db.session.add(new_schedule)
                db.session.commit()
                scheduler.last_schedule_id = new_schedule.id  # Store the ID
                
                # Add the job using the schedule library
                success = scheduler._add_job_from_schedule(new_schedule)
                
                if success:
                    scheduler_logger.info(f"✅ Schedule created successfully with ID: {new_schedule.id}")
                    return jsonify({
                        'success': True,
                        'data': {
                            'id': scheduler.last_schedule_id,  # Add the schedule ID
                            'message': 'Schedule saved successfully'
                        }
                    })
                else:
                    scheduler_logger.error("❌ Failed to create schedule")
                    db.session.delete(new_schedule)
                    db.session.commit()
                    return jsonify({
                        'success': False,
                        'message': 'Failed to add job to scheduler'
                    }), 500

            elif request.method == 'GET':
                schedules = ReportSchedule.query.all()
                return jsonify({
                    'success': True,
                    'data': [schedule.to_dict() for schedule in schedules]
                })

            elif request.method == 'PUT':
                schedule = ReportSchedule.query.get(schedule_id)
                if not schedule:
                    return jsonify({
                        'success': False,
                        'message': 'Schedule not found'
                    }), 404

                data = request.get_json()
                
                # Update schedule fields
                if 'time' in data:
                    schedule.time = data['time']
                if 'days' in data:
                    schedule.days = ','.join(map(str, data['days']))
                if 'reports' in data:
                    schedule.reports = ','.join(set(data['reports']))
                if 'email' in data:
                    schedule.email = data['email']
                if 'period_type' in data:
                    schedule.period_type = data['period_type']
                    # If period_type is 'range', update also from_date and to_date
                    if data['period_type'] == 'range':
                        if 'from_date' in data and 'to_date' in data:
                            try:
                                tz = get_configured_timezone()
                                from_date = datetime.strptime(data['from_date'], '%Y-%m-%d')
                                to_date = datetime.strptime(data['to_date'], '%Y-%m-%d')
                                # Add timezone if missing
                                if from_date.tzinfo is None:
                                    from_date = tz.localize(from_date)
                                if to_date.tzinfo is None:
                                    to_date = tz.localize(to_date)
                                schedule.from_date = from_date
                                schedule.to_date = to_date
                            except Exception as e:
                                scheduler_logger.error(f"Error parsing dates for range update: {e}")
                                return jsonify({
                                    'success': False,
                                    'message': f'Invalid date format: {str(e)}'
                                }), 400
                        else:
                            return jsonify({
                                'success': False,
                                'message': 'Both from_date and to_date are required for range period type'
                            }), 400
                if 'enabled' in data:
                    schedule.enabled = data['enabled']
                
                db.session.commit()
                
                # Update scheduler job
                scheduler.clear_jobs_for_schedule(schedule.id)
                success = scheduler._add_job_from_schedule(schedule)
                
                if not success:
                    return jsonify({
                        'success': False,
                        'message': 'Failed to update schedule in scheduler'
                    }), 500

                return jsonify({
                    'success': True,
                    'data': schedule.to_dict()
                })

            elif request.method == 'DELETE':
                schedule = ReportSchedule.query.get(schedule_id)
                if not schedule:
                    return jsonify({
                        'success': False,
                        'message': 'Schedule not found'
                    }), 404

                scheduler.clear_jobs_for_schedule(schedule.id)
                db.session.delete(schedule)
                db.session.commit()
                
                return jsonify({
                    'success': True,
                    'message': 'Schedule deleted successfully'
                })

        except Exception as e:
            scheduler_logger.error(f"❌ Error handling report schedules: {str(e)}", exc_info=True)
            return jsonify({
                'success': False,
                'message': str(e)
            }), 500

    @app.route('/api/settings/report/schedules/test', methods=['POST'])
    def test_schedule():
        """Test schedule configuration"""
        try:
            data = request.get_json()
            scheduler_logger.info(f"🧪 Testing schedule with data: {data}")
            
            # First check if there is a mail provided
            email = data.get('email')
            
            # If no email is provided, take the default one from the configuration
            if not email:
                mail_config = MailConfig.query.first()
                if mail_config and mail_config.enabled:
                    email = mail_config.to_email if hasattr(mail_config, 'to_email') else mail_config.from_email
            
            if not email:
                scheduler_logger.error("❌ No email configured")
                return jsonify({
                    'success': False,
                    'message': 'No email configured'
                }), 400
            
            period_type = data.get('period_type', 'yesterday')
            
            if period_type == 'range':
                from_date_str = data.get('from_date')
                to_date_str = data.get('to_date')
                
                if not from_date_str or not to_date_str:
                    return jsonify({
                        'success': False,
                        'message': 'From and To dates required for range'
                    }), 400
                    
                # Convert strings to datetime objects with timezone
                try:
                    tz = get_configured_timezone()
                    start_date = datetime.strptime(from_date_str, '%Y-%m-%d').replace(hour=0, minute=0, second=0)
                    end_date = datetime.strptime(to_date_str, '%Y-%m-%d').replace(hour=23, minute=59, second=59)
                    
                    # Add timezone if missing
                    if start_date.tzinfo is None:
                        start_date = tz.localize(start_date)
                    if end_date.tzinfo is None:
                        end_date = tz.localize(end_date)
                    
                    # If a single day is selected, use hrs
                    data_type = 'hrs' if start_date.date() == end_date.date() else 'days'
                except ValueError as e:
                    scheduler_logger.error(f"❌ Error parsing dates: {str(e)}")
                    return jsonify({
                        'success': False,
                        'message': f'Invalid date format: {str(e)}'
                    }), 400
            else:
                start_date, end_date, data_type = calculate_report_period(period_type)
            
            scheduler_logger.info(f"📧 Sending test report from {start_date} to {end_date}")
            success = scheduler.report_manager.generate_and_send_report(
                data['reports'],
                email,
                start_date,
                end_date,
                period_type
            )
            
            if success:
                scheduler_logger.info("✅ Test report sent successfully")
                return jsonify({
                    'success': True,
                    'message': 'Test report sent successfully',
                    'details': {
                        'email': email,
                        'from_date': start_date.isoformat(),
                        'to_date': end_date.isoformat(),
                        'reports': data['reports'],
                        'data_type': data_type,
                        'period_type': period_type
                    }
                })
            else:
                scheduler_logger.error("❌ Failed to send test report")
                return jsonify({
                    'success': False,
                    'message': 'Failed to send test report'
                }), 500

        except Exception as e:
            scheduler_logger.error(f"❌ Error testing schedule: {str(e)}", exc_info=True)
            return jsonify({
                'success': False,
                'message': str(e)
            }), 500

    @app.route('/api/settings/report/disable', methods=['POST'])
    def disable_report_scheduler():
        """Disable all report schedules"""
        try:
            ReportSchedule.query.update({ReportSchedule.enabled: False})
            db.session.commit()
            return jsonify(success=True, message="Report scheduler disabled successfully.")
        except Exception as e:
            db.session.rollback()
            return jsonify(success=False, message=str(e)), 500 