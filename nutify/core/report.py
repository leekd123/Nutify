from datetime import datetime, timedelta
import pytz
from core.logger import report_logger as logger, get_logger
from core.settings import get_configured_timezone, SERVER_NAME
from core.db_module import (
    db, data_lock, VariableConfig, get_ups_model, UPSEvent,
    ReportSchedule
)
from core.energy import (
    get_energy_data, 
    get_cost_trend_for_range, 
    calculate_energy_stats, 
    get_period_energy_data,
    calculate_cost_distribution,
    get_energy_rate,
    format_cost_series
)
from core.battery import get_battery_stats, get_battery_history
from core.power import get_power_stats, get_power_history
from core.mail import (
    send_email, 
    MailConfig
)
from flask import render_template, jsonify, request
import json
import os
import schedule
import time
import threading

import base64
from io import BytesIO
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from .voltage import get_voltage_stats, get_voltage_history
from typing import List, Optional
from email_validator import validate_email, EmailNotValidError
from tenacity import retry, stop_after_attempt, wait_exponential

logger.info("📄 Initializing report")
scheduler_logger = get_logger('scheduler')

class ReportManager:
    def __init__(self, app=None):
        logger.info("🚀 Initializing ReportManager with Schedule library")
        self.app = app
        self.tz = get_configured_timezone()
        if app:
            self.init_app(app)

    def init_app(self, app):
        try:
            self.app = app
            logger.info("✅ ReportManager initialized with app")
            
        except Exception as e:
            logger.error(f"Error in init_app: {str(e)}", exc_info=True)

    def _get_energy_report_data(self, from_date, to_date):
        """Collect energy report data using existing APIs"""
        try:
            logger.debug(f"Retrieving energy data from {from_date} to {to_date}")
            # Calculate the duration in days to determine the type of visualization
            duration_days = (to_date.date() - from_date.date()).days
            
            # Determine the appropriate period_type based on the duration
            if duration_days > 0:
                # If more than one day, use 'days'
                period_type = 'days'
            else:
                # If the same day, use 'hrs'
                period_type = 'hrs'
                
            logger.debug(f"Energy data retrieval period: {duration_days} days, using period_type={period_type}")
                
            # Use the API exactly as defined in energy.py
            energy_data = get_energy_data(
                start_date=from_date,  # The API uses start_date, not period or from_time
                end_date=to_date       # The API uses end_date, not to_time
            )
            
            # Convert totalEnergy from Wh to kWh for proper display in reports
            if 'totalEnergy' in energy_data:
                energy_data['totalEnergy'] = round(energy_data['totalEnergy'] / 1000, 2)  # Convert from Wh to kWh with 2 decimals
            
            # Take the cost trend using the correct API
            cost_trend = get_cost_trend_for_range(from_date, to_date)
            
            # Log for debug: verify the format of cost_trend data
            if cost_trend:
                if isinstance(cost_trend, list):
                    sample = cost_trend[0] if len(cost_trend) > 0 else "empty list"
                    logger.debug(f"Cost trend data format: list with {len(cost_trend)} items, first item: {sample}")
                else:
                    logger.debug(f"Cost trend data format: {type(cost_trend)}")
            else:
                logger.debug("Cost trend data is empty or None")
            
            # Determine if it's a single day report
            is_single_day = from_date.date() == to_date.date()
            # Force period_type based on duration
            period_type = 'hrs' if is_single_day else 'days'
            logger.info(f"Energy report period_type determined as: {period_type}")
            
            # Generate chart with proper period_type and actual date range
            # Pass the date range to the method to ensure the chart has the correct interval
            chart_data = {
                'data': cost_trend,
                'from_date': from_date,
                'to_date': to_date
            }
            
            chart_url = self._generate_chart_image(chart_data, 'energy', is_single_day)
            
            return {
                'include_energy': True,
                'energy_stats': energy_data,
                'energy_chart_url': chart_url,
                'period_type': period_type
            }
        except Exception as e:
            logger.error(f"Error getting energy report data: {str(e)}")
            return {'include_energy': False}

    def _get_battery_report_data(self, from_date, to_date):
        """Collect battery report data using existing APIs"""
        try:
            # Determine if the period is a single day
            is_same_day = from_date.date() == to_date.date()
            
            if is_same_day:
                # If the same day, use the period='day' format with selected_date
                battery_stats = get_battery_stats(
                    period='day',
                    selected_date=from_date
                )
                
                history_data = get_battery_history(
                    period='day',
                    selected_date=from_date
                )
                
                # Get voltage data for the same period
                voltage_stats = get_voltage_stats(
                    period='day',
                    from_time="00:00",
                    to_time="23:59"
                )
            else:
                # For multi-day periods, use the period='range' format
                battery_stats = get_battery_stats(
                    period='range',
                    from_time=from_date.strftime('%Y-%m-%d'),
                    to_time=to_date.strftime('%Y-%m-%d')
                )
                
                history_data = get_battery_history(
                    period='range',
                    from_date=from_date.strftime('%Y-%m-%d'),
                    to_date=to_date.strftime('%Y-%m-%d')
                )
                
                # Get voltage data for the same period
                voltage_stats = get_voltage_stats(
                    period='range',
                    from_time=from_date.strftime('%Y-%m-%d'),
                    to_time=to_date.strftime('%Y-%m-%d')
                )
            
            # Ensure all values are properly initialized to avoid None errors
            for metric in battery_stats:
                if isinstance(battery_stats[metric], dict):
                    for key in ['min', 'max', 'avg']:
                        if key in battery_stats[metric] and battery_stats[metric][key] is None:
                            battery_stats[metric][key] = 0
            
            # Check if any voltage data is available from battery_stats
            has_battery_voltage = (
                'battery_voltage' in battery_stats and 
                battery_stats['battery_voltage'].get('avg', 0) > 0
            )
            
            # Check if any voltage data is available from voltage_stats
            has_input_voltage = False
            has_output_voltage = False
            input_voltage_value = 0
            output_voltage_value = 0
            
            # Check for input voltage
            if 'input_voltage' in voltage_stats and voltage_stats['input_voltage'].get('avg', 0) > 0:
                has_input_voltage = True
                input_voltage_value = voltage_stats['input_voltage']['avg']
            
            # Check for output voltage
            if 'output_voltage' in voltage_stats and voltage_stats['output_voltage'].get('avg', 0) > 0:
                has_output_voltage = True
                output_voltage_value = voltage_stats['output_voltage']['avg']
            
            # Determine if we should show the voltage section
            show_voltage_section = has_battery_voltage or has_input_voltage or has_output_voltage
            
            # Add voltage data to the report
            voltage_data = {
                'has_battery_voltage': has_battery_voltage,
                'has_input_voltage': has_input_voltage,
                'has_output_voltage': has_output_voltage,
                'show_voltage_section': show_voltage_section,
                'input_voltage_value': input_voltage_value,
                'output_voltage_value': output_voltage_value
            }
            
            return {
                'include_battery': True,
                'battery_stats': battery_stats,
                'battery_chart_url': self._generate_chart_image(history_data, 'battery'),
                **voltage_data  # Include all voltage data
            }
        except Exception as e:
            logger.error(f"Error getting battery report data: {str(e)}")
            return {'include_battery': False}

    def _get_power_report_data(self, from_date, to_date):
        """Collect power report data"""
        try:
            # Determine if the period is a single day
            is_same_day = from_date.date() == to_date.date()
            
            if is_same_day:
                # If the same day, use the period='day' format with selected_date
                power_stats = get_power_stats(
                    period='day',
                    selected_date=from_date
                )
                
                history_data = get_power_history(
                    period='day',
                    selected_date=from_date
                )
            else:
                # For multi-day periods, use the period='range' format
                power_stats = get_power_stats(
                    period='range',
                    from_time=from_date.strftime('%Y-%m-%d'),
                    to_time=to_date.strftime('%Y-%m-%d')
                )
                
                history_data = get_power_history(
                    period='range',
                    from_date=from_date.strftime('%Y-%m-%d'),
                    to_date=to_date.strftime('%Y-%m-%d')
                )

            # Reorganize the data in the format expected by the template
            try:
                # Convert total_energy from Wh to kWh for proper display in reports
                total_energy_wh = 0
                if 'ups_realpower' in power_stats and 'total_energy' in power_stats['ups_realpower']:
                    total_energy_wh = power_stats['ups_realpower']['total_energy']
                    total_energy_kwh = total_energy_wh / 1000  # Convert from Wh to kWh
                
                # Get input voltage - try input_voltage first, then input_transfer_high/low
                input_voltage = 0
                if 'input_voltage' in power_stats and 'avg' in power_stats['input_voltage']:
                    input_voltage = power_stats['input_voltage']['avg']
                elif 'input_transfer_high' in power_stats and 'input_transfer_low' in power_stats:
                    # If input_voltage is not available, but input_transfer_high and input_transfer_low are,
                    # use the average as an approximation
                    high = 0
                    low = 0
                    
                    if isinstance(power_stats['input_transfer_high'], dict) and 'avg' in power_stats['input_transfer_high']:
                        high = power_stats['input_transfer_high']['avg']
                    elif isinstance(power_stats['input_transfer_high'], (int, float)):
                        high = power_stats['input_transfer_high']
                    
                    if isinstance(power_stats['input_transfer_low'], dict) and 'avg' in power_stats['input_transfer_low']:
                        low = power_stats['input_transfer_low']['avg']
                    elif isinstance(power_stats['input_transfer_low'], (int, float)):
                        low = power_stats['input_transfer_low']
                    
                    if high > 0 and low > 0:
                        input_voltage = (high + low) / 2
                        logger.debug(f"Using average of transfer thresholds as input voltage: {input_voltage}")
                
                # Get output voltage
                output_voltage = 0
                if 'output_voltage' in power_stats:
                    if isinstance(power_stats['output_voltage'], dict) and 'avg' in power_stats['output_voltage']:
                        output_voltage = power_stats['output_voltage']['avg']
                    elif isinstance(power_stats['output_voltage'], (int, float)):
                        output_voltage = power_stats['output_voltage']
                
                # Get nominal power - try ups_realpower_nominal first, then ups_power_nominal
                nominal_power = 0
                if 'ups_realpower_nominal' in power_stats:
                    if isinstance(power_stats['ups_realpower_nominal'], dict) and 'avg' in power_stats['ups_realpower_nominal']:
                        nominal_power = power_stats['ups_realpower_nominal']['avg']
                    elif isinstance(power_stats['ups_realpower_nominal'], (int, float)):
                        nominal_power = power_stats['ups_realpower_nominal']
                elif 'ups_power_nominal' in power_stats:
                    if isinstance(power_stats['ups_power_nominal'], dict) and 'avg' in power_stats['ups_power_nominal']:
                        nominal_power = power_stats['ups_power_nominal']['avg']
                    elif isinstance(power_stats['ups_power_nominal'], (int, float)):
                        nominal_power = power_stats['ups_power_nominal']
                
                # Get load
                load = 0
                if 'ups_load' in power_stats:
                    if isinstance(power_stats['ups_load'], dict):
                        if 'current' in power_stats['ups_load']:
                            load = power_stats['ups_load']['current']
                        elif 'avg' in power_stats['ups_load']:
                            load = power_stats['ups_load']['avg']
                    elif isinstance(power_stats['ups_load'], (int, float)):
                        load = power_stats['ups_load']
                
                processed_stats = {
                    'total_consumption': total_energy_kwh,  # Now in kWh instead of Wh
                    'input_voltage': input_voltage,
                    'output_voltage': output_voltage,
                    'nominal_power': nominal_power,
                    'load': load
                }
                
                # Log the processed stats for debugging
                logger.debug(f"Processed power stats: {processed_stats}")
                
            except (KeyError, TypeError) as e:
                logger.warning(f"Unable to process all power data: {str(e)}")
                processed_stats = {
                    'total_consumption': 0,
                    'input_voltage': 0,
                    'output_voltage': 0,
                    'nominal_power': 0,
                    'load': 0
                }

            return {
                'include_power': True,
                'power_stats': processed_stats,
                'power_chart_url': self._generate_chart_image(history_data, 'power')
            }

        except Exception as e:
            logger.error(f"Error getting power report data: {str(e)}", exc_info=True)
            return {'include_power': False}

    def _get_voltage_report_data(self, from_date, to_date):
        """Collect voltage report data using existing APIs"""
        try:
            # Initialize flag variables at the beginning
            has_input_voltage = False
            has_output_voltage = False
            has_transfer_thresholds = False
            
            # Determine if the period is a single day
            is_same_day = from_date.date() == to_date.date()
            
            if is_same_day:
                # If the same day, use the period='day' format with selected_day
                voltage_stats = get_voltage_stats(
                    period='day',
                    from_time="00:00",  # Start of day
                    to_time="23:59"     # End of day
                )
                
                history_data = get_voltage_history(
                    period='day',
                    selected_day=from_date.strftime('%Y-%m-%d')
                )
            else:
                # For multi-day periods, use the period='range' format
                voltage_stats = get_voltage_stats(
                    period='range',
                    from_time=from_date.strftime('%Y-%m-%d'),
                    to_time=to_date.strftime('%Y-%m-%d')
                )
                
                history_data = get_voltage_history(
                    period='range',
                    from_time=from_date.strftime('%Y-%m-%d'),
                    to_time=to_date.strftime('%Y-%m-%d')
                )
            
            # Normalize the voltage_stats to ensure all fields are present
            normalized_stats = {}
            
            # Check for input_voltage
            if 'input_voltage' in voltage_stats and isinstance(voltage_stats['input_voltage'], dict):
                has_input_voltage = voltage_stats['input_voltage'].get('available', False) and voltage_stats['input_voltage'].get('avg', 0) > 0
                normalized_stats['input_voltage'] = voltage_stats['input_voltage'].get('avg', 0)
                normalized_stats['input_voltage_min'] = voltage_stats['input_voltage'].get('min', 0)
                normalized_stats['input_voltage_max'] = voltage_stats['input_voltage'].get('max', 0)
                normalized_stats['input_voltage_avg'] = voltage_stats['input_voltage'].get('avg', 0)
                logger.debug(f"Field input_voltage is a dictionary: {voltage_stats['input_voltage']}")
            else:
                normalized_stats['input_voltage'] = 0.0
                normalized_stats['input_voltage_min'] = 0.0
                normalized_stats['input_voltage_max'] = 0.0
                normalized_stats['input_voltage_avg'] = 0.0
                logger.debug(f"Field input_voltage missing, set to 0.0")
            
            # Check for output_voltage
            if 'output_voltage' in voltage_stats and isinstance(voltage_stats['output_voltage'], dict):
                has_output_voltage = voltage_stats['output_voltage'].get('available', False) and voltage_stats['output_voltage'].get('avg', 0) > 0
                normalized_stats['output_voltage'] = voltage_stats['output_voltage'].get('avg', 0)
                normalized_stats['output_voltage_min'] = voltage_stats['output_voltage'].get('min', 0)
                normalized_stats['output_voltage_max'] = voltage_stats['output_voltage'].get('max', 0)
                normalized_stats['output_voltage_avg'] = voltage_stats['output_voltage'].get('avg', 0)
                logger.debug(f"Field output_voltage is a dictionary: {voltage_stats['output_voltage']}")
            else:
                normalized_stats['output_voltage'] = 0.0
                normalized_stats['output_voltage_min'] = 0.0
                normalized_stats['output_voltage_max'] = 0.0
                normalized_stats['output_voltage_avg'] = 0.0
                logger.debug(f"Field output_voltage missing, set to 0.0")
            
            # Add other fields with default values if missing
            for field in ['battery_voltage', 'input_frequency', 'output_frequency', 'load_percentage', 'input_transfer_low', 'input_transfer_high']:
                if field in voltage_stats:
                    if isinstance(voltage_stats[field], dict):
                        normalized_stats[field] = voltage_stats[field].get('avg', 0)
                        if field == 'battery_voltage':
                            normalized_stats['battery_voltage_min'] = voltage_stats[field].get('min', 0)
                            normalized_stats['battery_voltage_max'] = voltage_stats[field].get('max', 0)
                            normalized_stats['battery_voltage_avg'] = voltage_stats[field].get('avg', 0)
                    elif isinstance(voltage_stats[field], (int, float)):
                        normalized_stats[field] = voltage_stats[field]
                        if field == 'battery_voltage':
                            normalized_stats['battery_voltage_min'] = voltage_stats[field]
                            normalized_stats['battery_voltage_max'] = voltage_stats[field]
                            normalized_stats['battery_voltage_avg'] = voltage_stats[field]
                else:
                    normalized_stats[field] = 0.0
                    if field == 'battery_voltage':
                        normalized_stats['battery_voltage_min'] = 0.0
                        normalized_stats['battery_voltage_max'] = 0.0
                        normalized_stats['battery_voltage_avg'] = 0.0
                    logger.debug(f"Field {field} missing, set to 0.0")
            
            # Check for transfer thresholds
            has_transfer_thresholds = normalized_stats['input_transfer_low'] > 0 and normalized_stats['input_transfer_high'] > 0
            
            # Log the fields after normalization
            logger.debug(f"Fields of voltage_stats after normalization: {list(normalized_stats.keys())}")
            
            # Determine if we have input and output voltage data
            logger.debug(f"Voltage data: input={has_input_voltage}, output={has_output_voltage}")
            
            # Generate the chart
            chart_url = ""
            if history_data:
                # Clean the data to include only those actually available
                cleaned_history_data = {}
                
                # Include only real input_voltage data if available
                if 'input_voltage' in history_data and history_data['input_voltage']:
                    cleaned_history_data['input_voltage'] = history_data['input_voltage']
                
                # Include only real output_voltage data if available
                if 'output_voltage' in history_data and history_data['output_voltage']:
                    cleaned_history_data['output_voltage'] = history_data['output_voltage']
                
                # Include transfer thresholds if available
                if 'input_transfer_low' in history_data and history_data['input_transfer_low']:
                    cleaned_history_data['input_transfer_low'] = history_data['input_transfer_low']
                
                if 'input_transfer_high' in history_data and history_data['input_transfer_high']:
                    cleaned_history_data['input_transfer_high'] = history_data['input_transfer_high']
                
                # Use the cleaned data to generate the chart
                chart_url = self._generate_chart_image(cleaned_history_data, 'voltage')
            
            return {
                'include_voltage': True,
                'voltage_stats': normalized_stats,
                'has_input_voltage': has_input_voltage,
                'has_output_voltage': has_output_voltage,
                'has_transfer_thresholds': has_transfer_thresholds,
                'voltage_chart_url': chart_url
            }
        except Exception as e:
            logger.error(f"Error getting voltage report data: {str(e)}", exc_info=True)
            return {'include_voltage': False}

    def _get_events_report_data(self, from_date, to_date):
        """Collect events report data"""
        try:
            events = UPSEvent.query.filter(
                UPSEvent.timestamp_tz >= from_date,
                UPSEvent.timestamp_tz <= to_date
            ).order_by(UPSEvent.timestamp_tz.desc()).all()
            
            if not events:
                return {'include_events': False}
            
            events_data = [{
                'timestamp': event.timestamp_tz.strftime('%Y-%m-%d %H:%M:%S'),
                'event': event.event_type
            } for event in events]
            
            return {
                'include_events': True,
                'events_data': events_data
            }
        except Exception as e:
            logger.error(f"Error getting events report data: {str(e)}")
            return {'include_events': False}

    def _generate_power_chart(self, power_data):
        """Generate power chart with dual Y axis"""
        try:
            logger.debug("Generating power chart")
            logger.debug(f"Raw power data: {json.dumps(power_data, indent=2)}")
            
            if not power_data:
                logger.warning("Missing power data for chart")
                return ""
            
            # Create the chart with two Y axes
            fig = make_subplots(specs=[[{"secondary_y": True}]])
            
            # Add the power line (primary Y axis)
            if 'ups_realpower' in power_data:
                x = [datetime.fromisoformat(point['timestamp']) for point in power_data['ups_realpower']]
                y = [point['value'] for point in power_data['ups_realpower']]
                fig.add_trace(
                    go.Scatter(
                        x=x,
                        y=y,
                        name="Real Power",
                        line=dict(color="#2563eb")
                    ),
                    secondary_y=False
                )
            
            # Add the voltage line (secondary Y axis)
            if 'input_voltage' in power_data:
                x = [datetime.fromisoformat(point['timestamp']) for point in power_data['input_voltage']]
                y = [point['value'] for point in power_data['input_voltage']]
                fig.add_trace(
                    go.Scatter(
                        x=x,
                        y=y,
                        name="Input Voltage",
                        line=dict(color="#10b981")
                    ),
                    secondary_y=True
                )
            
            # Update the layout
            fig.update_layout(
                title="Power Analysis",
                plot_bgcolor='white',
                paper_bgcolor='white',
                font=dict(size=12),
                margin=dict(l=50, r=50, t=50, b=50),
                legend=dict(
                    orientation="h",
                    yanchor="bottom",
                    y=1.02,
                    xanchor="right",
                    x=1
                )
            )
            
            # Update the axis titles
            fig.update_yaxes(title_text="Real Power (W)", secondary_y=False)
            fig.update_yaxes(title_text="Input Voltage (V)", secondary_y=True)
            fig.update_xaxes(title_text="Time")
            
            # Save the chart as a base64 image
            img_bytes = fig.to_image(format="png", width=800, height=400)
            graph = base64.b64encode(img_bytes).decode('utf-8')
            
            logger.debug("Power chart generated successfully")
            return f"data:image/png;base64,{graph}"
            
        except Exception as e:
            logger.error(f"Error generating power chart: {str(e)}", exc_info=True)
            return ""

    def generate_energy_chart(self, data, period_type, start_date, end_date):
        """
        Generate the energy chart using Plotly
        """
        try:
            # Create the bar chart
            fig = go.Figure()
            
            # Get the currency from the settings
            variable_config = VariableConfig.query.first()
            currency = variable_config.currency if variable_config else 'EUR'
            
            # Map the currency to its symbol
            currency_symbols = {
                'EUR': '€',
                'USD': '$',
                'GBP': '£',
                'JPY': '¥',
                'AUD': 'A$',
                'CAD': 'C$',
                'CHF': 'CHF',
                'CNY': '¥',
                'INR': '₹',
                'NZD': 'NZ$',
                'BRL': 'R$',
                'RUB': '₽',
                'KRW': '₩'
            }
            currency_symbol = currency_symbols.get(currency, '€')
            
            # Get the energy cost rate
            energy_rate = get_energy_rate()

            # Calculate the duration in days to determine the type of visualization
            duration_days = (end_date.date() - start_date.date()).days
            
            # If period_type is 'hrs', keep 'hrs' for hourly visualization
            # If days <= 30, keep 'days' for daily visualization
            # If days > 30, change to 'months' for monthly visualization
            if period_type != 'hrs' and duration_days > 30:
                period_type = 'months'
                logger.debug(f"Large interval detected ({duration_days} days), using monthly visualization")

            if period_type == 'hrs':
                # Hourly chart (24 bars)
                logger.debug(f"Generating hourly energy chart from {start_date} to {end_date}")
                
                # For hourly data, we need to retrieve the actual values from the tables
                UPSDynamicData = get_ups_model()
                
                # Ensure that start_date and end_date cover the entire day
                day_date = start_date.date()
                if start_date.hour == 0 and start_date.minute == 0 and end_date.hour == 23 and end_date.minute == 59:
                    logger.debug("Using full day range for hourly data")
                else:
                    logger.debug("Adjusting to full day range for consistency")
                    start_date = datetime.combine(day_date, datetime.min.time(), tzinfo=start_date.tzinfo)
                    end_date = datetime.combine(day_date, datetime.max.time(), tzinfo=end_date.tzinfo)
                
                # Retrieve the hours from the start of the day to the end (or from the specified range)
                hour_data = UPSDynamicData.query.filter(
                    UPSDynamicData.timestamp_tz >= start_date,
                    UPSDynamicData.timestamp_tz <= end_date,
                    UPSDynamicData.ups_realpower_hrs.isnot(None)
                ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                
                if hour_data:
                    logger.debug(f"Found {len(hour_data)} hourly data points")
                    hours = []
                    values = []
                    
                    for entry in hour_data:
                        hour_str = entry.timestamp_tz.strftime('%H:00')
                        energy_wh = float(entry.ups_realpower_hrs) if entry.ups_realpower_hrs is not None else 0
                        hours.append(hour_str)
                        values.append(energy_wh)
                    
                    # Calculate the cost for each hour
                    costs = [(v / 1000) * energy_rate for v in values]  # Convert Wh to kWh for cost calculation
                    
                    # Calculate the total energy and cost
                    total_energy = sum(values)
                    total_cost = sum(costs)
                        
                    fig.add_trace(go.Bar(
                        x=hours,
                        y=values,
                        name='Energy Consumption',
                        text=None,
                        textposition='none',
                        marker_color='#3366CC'
                    ))
                    
                    # Empty title
                    title = ""
                    
                    fig.update_layout(
                        title=title,
                        xaxis_title="Hour",
                        yaxis_title="Energy (Wh)",
                        bargap=0.2
                    )
                else:
                    # Fallback: if no hourly data is found, distribute the total energy uniformly
                    logger.debug("No hourly data found, using uniform distribution")
                    hours = []
                    values = []
                    
                    # Prepare an array of 24 hours for a full day
                    for hour in range(24):
                        hour_str = f"{hour:02d}:00"
                        # Use the hourly data
                        value = data['totalEnergy'] / 24 if isinstance(data, dict) and 'totalEnergy' in data else 0  # Distribute the total energy over 24 hours
                        hours.append(hour_str)
                        values.append(value)
                    
                    # Calculate the cost for each hour
                    costs = [(v / 1000) * energy_rate for v in values]  # Convert Wh to kWh for cost calculation
                    
                    # Calculate the total energy and cost
                    total_energy = sum(values)
                    total_cost = sum(costs)
            
                    fig.add_trace(go.Bar(
                        x=hours,
                        y=values,
                        name='Energy Consumption',
                        text=None,
                        textposition='none',
                        marker_color='#3366CC'
                    ))
                    
                    # Empty title
                    title = ""
                    
                    fig.update_layout(
                        title=title,
                        xaxis_title="Hour",
                        yaxis_title="Energy (Wh)",
                        bargap=0.2
                    )
            elif period_type == 'months':
                # Monthly chart for wide intervals
                logger.debug(f"Generating monthly energy chart from {start_date} to {end_date}")
                
                # Group the data by month
                monthly_data = {}
                
                # If data is a list of points with timestamp, group by month
                if isinstance(data, list):
                    for point in data:
                        try:
                            if isinstance(point, list) and len(point) >= 2:
                                # Format [timestamp, value]
                                timestamp = datetime.fromtimestamp(point[0]/1000, start_date.tzinfo)
                                value = point[1]
                            elif isinstance(point, dict) and 'timestamp' in point and 'value' in point:
                                # Format {'timestamp': timestamp_str, 'value': value}
                                timestamp = datetime.fromisoformat(point['timestamp'])
                                value = point['value']
                            else:
                                continue
                                
                            month_key = timestamp.strftime('%Y-%m')
                            if month_key not in monthly_data:
                                monthly_data[month_key] = 0
                            monthly_data[month_key] += value
                        except Exception as e:
                            logger.error(f"Error processing data point for monthly chart: {e}")
                    
                    # If there are no valid data, use a default period
                    if not monthly_data:
                        # Generate fake data for the period
                        current_date = start_date.replace(day=1)
                        while current_date <= end_date:
                            month_key = current_date.strftime('%Y-%m')
                            monthly_data[month_key] = 0
                            # Go to the next month
                            if current_date.month == 12:
                                current_date = current_date.replace(year=current_date.year+1, month=1)
                            else:
                                current_date = current_date.replace(month=current_date.month+1)
                
                # Sort the months chronologically
                sorted_months = sorted(monthly_data.keys())
                month_labels = [datetime.strptime(m, '%Y-%m').strftime('%b %Y') for m in sorted_months]
                month_values = [monthly_data[m] for m in sorted_months]
                
                # Calculate the cost for each month
                costs = [(v / 1000) * energy_rate for v in month_values]  # Convert Wh to kWh for cost calculation
                
                # Calculate the total energy and cost
                total_energy = sum(month_values)
                total_cost = sum(costs)
                
                fig.add_trace(go.Bar(
                    x=month_labels,
                    y=month_values,
                    name='Monthly Energy',
                    text=None,
                    textposition='none',
                    marker_color='#3366CC'
                ))
                
                # Empty title
                title = ""
                
                fig.update_layout(
                    title=title,
                    xaxis_title="Month",
                    yaxis_title="Energy (Wh)",
                    bargap=0.2
                )
            else:  # days
                # Daily chart
                dates = []
                values = []
                
                current_date = start_date
                while current_date <= end_date:
                    date_str = current_date.strftime('%Y-%m-%d')
                    
                    # Handle different data formats
                    value = 0
                    try:
                        if isinstance(data, list):
                            # The format might be a list of dictionaries or a list of lists
                            if len(data) > 0:
                                if isinstance(data[0], dict) and 'timestamp' in data[0] and 'value' in data[0]:
                                    # Format: list of dictionaries with 'timestamp' and 'value'
                                    value = next(
                                        (d['value'] for d in data if datetime.fromisoformat(d['timestamp']).strftime('%Y-%m-%d') == date_str),
                                        0
                                    )
                                elif isinstance(data[0], list) and len(data[0]) >= 2:
                                    # Format: list of lists [timestamp, value]
                                    day_start = datetime.combine(current_date.date(), datetime.min.time(), tzinfo=current_date.tzinfo)
                                    day_end = datetime.combine(current_date.date(), datetime.max.time(), tzinfo=current_date.tzinfo)
                                    
                                    # Find all data points for this day and sum them
                                    day_value = 0
                                    for point in data:
                                        try:
                                            point_time = datetime.fromtimestamp(point[0]/1000, current_date.tzinfo)
                                            if day_start <= point_time <= day_end:
                                                day_value += point[1]
                                        except (IndexError, ValueError, TypeError) as e:
                                            logger.debug(f"Skipping invalid data point: {e}")
                                    
                                    value = day_value
                        elif isinstance(data, dict) and 'totalEnergy' in data:
                            # If we don't find data for a day, distribute the total energy uniformly
                            value = data['totalEnergy'] / max(1, (end_date - start_date).days + 1)
                    except Exception as e:
                        logger.error(f"Error processing data for {date_str}: {e}")
                    
                    dates.append(date_str)
                    values.append(value)
                    current_date += timedelta(days=1)
                
                logger.debug(f"Daily chart: generated {len(dates)} days from {start_date} to {end_date}")
                
                # Calculate the cost for each day
                costs = [(v / 1000) * energy_rate for v in values]  # Convert Wh to kWh for cost calculation
                
                # Calculate the total energy and cost
                total_energy = sum(values)
                total_cost = sum(costs)
                
                fig.add_trace(go.Bar(
                    x=dates,
                    y=values,
                    name='Energy Consumption',
                    text=None,
                    textposition='none',
                    marker_color='#3366CC'
                ))
                
                # Empty title
                title = ""
                
                fig.update_layout(
                    title=title,
                    xaxis_title="Date",
                    yaxis_title="Energy (Wh)",
                    bargap=0.2
                )

            # Common settings
            fig.update_layout(
                template='plotly_white',
                showlegend=False,  # Remove the legend to gain space
                height=600,
                margin=dict(t=100, b=50, l=50, r=50)
            )

            # Convert the chart to a base64 image
            img_bytes = fig.to_image(format="png", width=1200, height=600)
            encoded = base64.b64encode(img_bytes).decode('utf-8')
            return f"data:image/png;base64,{encoded}"

        except Exception as e:
            logger.error(f"Error generating energy chart: {str(e)}")
            return None

    def _calculate_date_range(self, period_type, from_date=None, to_date=None):
        """Calculate the date range consistently"""
        now = datetime.now(self.tz)
        logger.debug(f"Calculating date range for period_type: {period_type}")
        
        if period_type == 'yesterday':
            from_date = (now - timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0)
            to_date = from_date.replace(
                hour=23, minute=59, second=59, microsecond=999999)
            is_hourly = True  # Yesterday must always use hourly visualization
            logger.debug(f"Yesterday range: {from_date} to {to_date}")
        elif period_type == 'last_week':
            # Find the Monday of current week
            monday_this_week = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=now.weekday())
            # Find the Monday of previous week
            monday_last_week = monday_this_week - timedelta(days=7)
            # Find the Sunday of previous week
            sunday_last_week = monday_last_week + timedelta(days=6)
            
            from_date = monday_last_week
            to_date = sunday_last_week.replace(hour=23, minute=59, second=59, microsecond=999999)
            is_hourly = False
            logger.debug(f"Last week range: {from_date} to {to_date}")
        elif period_type == 'last_month':
            # More precise month calculation
            first_day = now.replace(day=1)  # First day of current month
            last_month_end = first_day - timedelta(days=1)  # Last day of previous month
            from_date = last_month_end.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            to_date = last_month_end.replace(hour=23, minute=59, second=59, microsecond=999999)
            is_hourly = False
            logger.debug(f"Last month range: {from_date} to {to_date}")
        elif period_type == 'range' and from_date and to_date:
            # Usa le date fornite
            try:
                # If from_date and to_date are strings, convert them to datetime
                if isinstance(from_date, str):
                    from_date = datetime.strptime(from_date, '%Y-%m-%d')
                if isinstance(to_date, str):
                    to_date = datetime.strptime(to_date, '%Y-%m-%d')
                
                from_date = from_date.replace(hour=0, minute=0, second=0, microsecond=0)
                to_date = to_date.replace(hour=23, minute=59, second=59, microsecond=999999)
                is_hourly = from_date.date() == to_date.date()  # Hourly only if the date is the same
                logger.debug(f"Custom range: {from_date} to {to_date}, is_hourly: {is_hourly}")
            except Exception as e:
                logger.error(f"Error parsing custom date range: {e}")
                # Fallback to yesterday
                from_date = (now - timedelta(days=1)).replace(
                    hour=0, minute=0, second=0, microsecond=0)
                to_date = from_date.replace(
                    hour=23, minute=59, second=59, microsecond=999999)
                is_hourly = True
        else:
            # Default to yesterday
            from_date = (now - timedelta(days=1)).replace(
                hour=0, minute=0, second=0, microsecond=0)
            to_date = from_date.replace(
                hour=23, minute=59, second=59, microsecond=999999)
            is_hourly = True
            logger.debug(f"Default range (yesterday): {from_date} to {to_date}")

        # Ensure the dates have the timezone
        if from_date.tzinfo is None:
            from_date = self.tz.localize(from_date)
        if to_date.tzinfo is None:
            to_date = self.tz.localize(to_date)

        return from_date, to_date, is_hourly

    def generate_and_send_report(self, report_types, email, from_date=None, to_date=None, period_type='yesterday'):
        try:
            # If the dates are already provided, use them directly
            if from_date and to_date:
                logger.info(f"Using provided date range: {from_date} to {to_date}")
                is_hourly = from_date.date() == to_date.date()
            else:
                # Otherwise calculate the range based on the period_type
                from_date, to_date, is_hourly = self._calculate_date_range(period_type)
                logger.info(f"Calculated date range for {period_type}: {from_date} to {to_date}")

            # Ensure the dates have the timezone
            if from_date.tzinfo is None:
                from_date = self.tz.localize(from_date)
            if to_date.tzinfo is None:
                to_date = self.tz.localize(to_date)

            # Calculate the duration including the last day
            duration = (to_date.date() - from_date.date()).days + 1

            logger.info("Report period details:")
            logger.info(f"- From: {from_date.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            logger.info(f"- To: {to_date.strftime('%Y-%m-%d %H:%M:%S %Z')}")
            logger.info(f"- Type: {'hrs' if is_hourly else 'days'}")
            logger.info(f"- Duration: {duration} days")
            logger.info(f"- Is hourly: {is_hourly}")
            logger.info(f"- Period type: {period_type}")

            # Check email notifications
            mail_config = MailConfig.query.first()
            if not mail_config or not mail_config.enabled:
                logger.warning("Email notifications are disabled")
                return False

            # List of providers that have issues with base64 inline images
            problematic_providers = ['gmail', 'yahoo', 'outlook', 'office365']
            provider = mail_config.provider.lower() if mail_config.provider else ''
            needs_cid = provider in problematic_providers
            
            # Initialize attachments list only if needed
            attachments = [] if needs_cid else None

            # Get the currency from the settings
            variable_config = VariableConfig.query.first()
            currency = variable_config.currency if variable_config else 'EUR'
            
            # Map the currency to its symbol
            currency_symbols = {
                'EUR': '€',
                'USD': '$',
                'GBP': '£',
                'JPY': '¥',
                'AUD': 'A$',
                'CAD': 'C$',
                'CHF': 'CHF',
                'CNY': '¥',
                'INR': '₹',
                'NZD': 'NZ$',
                'BRL': 'R$',
                'RUB': '₽',
                'KRW': '₩'
            }
            currency_symbol = currency_symbols.get(currency, '€')
            
            # Prepare the report data with default values
            report_data = {
                'from_date': from_date.strftime('%Y-%m-%d'),
                'to_date': to_date.strftime('%Y-%m-%d'),
                'generation_date': datetime.now(self.tz).strftime('%Y-%m-%d %H:%M:%S'),
                'current_year': datetime.now(self.tz).year,
                'duration_days': duration,
                'is_hourly': is_hourly,
                'period_type': period_type,
                'currency': currency_symbol,
                'server_name': SERVER_NAME,
                'is_problematic_provider': needs_cid  # Add this flag for template
            }

            # Collect data based on selected report types
            for report_type in report_types:
                logger.info(f"Collecting data for {report_type} report")
                try:
                    if report_type == 'energy':
                        energy_data = self._get_energy_report_data(from_date, to_date)
                        if energy_data and 'energy_chart_url' in energy_data:
                            # Convert base64 to CID only for problematic providers
                            if needs_cid and energy_data['energy_chart_url'].startswith('data:image/png;base64,'):
                                img_data = energy_data['energy_chart_url'].split(',')[1]
                                cid = f"energy_chart_{len(attachments)}"
                                attachments.append({
                                    'data': base64.b64decode(img_data),
                                    'cid': cid,
                                    'type': 'image/png',
                                    'name': 'energy_chart.png'
                                })
                                energy_data['energy_chart_url'] = f"cid:{cid}"
                        report_data.update(energy_data or {'include_energy': False})

                    elif report_type == 'battery':
                        battery_data = self._get_battery_report_data(from_date, to_date)
                        if battery_data and 'battery_chart_url' in battery_data:
                            if needs_cid and battery_data['battery_chart_url'].startswith('data:image/png;base64,'):
                                img_data = battery_data['battery_chart_url'].split(',')[1]
                                cid = f"battery_chart_{len(attachments)}"
                                attachments.append({
                                    'data': base64.b64decode(img_data),
                                    'cid': cid,
                                    'type': 'image/png',
                                    'name': 'battery_chart.png'
                                })
                                battery_data['battery_chart_url'] = f"cid:{cid}"
                        report_data.update(battery_data or {'include_battery': False})

                    elif report_type == 'power':
                        power_data = self._get_power_report_data(from_date, to_date)
                        if power_data and 'power_chart_url' in power_data:
                            if needs_cid and power_data['power_chart_url'].startswith('data:image/png;base64,'):
                                img_data = power_data['power_chart_url'].split(',')[1]
                                cid = f"power_chart_{len(attachments)}"
                                attachments.append({
                                    'data': base64.b64decode(img_data),
                                    'cid': cid,
                                    'type': 'image/png',
                                    'name': 'power_chart.png'
                                })
                                power_data['power_chart_url'] = f"cid:{cid}"
                        report_data.update(power_data or {'include_power': False})

                    elif report_type == 'voltage':
                        voltage_data = self._get_voltage_report_data(from_date, to_date)
                        if voltage_data and 'voltage_chart_url' in voltage_data:
                            if needs_cid and voltage_data['voltage_chart_url'].startswith('data:image/png;base64,'):
                                img_data = voltage_data['voltage_chart_url'].split(',')[1]
                                cid = f"voltage_chart_{len(attachments)}"
                                attachments.append({
                                    'data': base64.b64decode(img_data),
                                    'cid': cid,
                                    'type': 'image/png',
                                    'name': 'voltage_chart.png'
                                })
                                voltage_data['voltage_chart_url'] = f"cid:{cid}"
                        report_data.update(voltage_data or {'include_voltage': False})

                    elif report_type == 'events':
                        events_data = self._get_events_report_data(from_date, to_date)
                        report_data.update(events_data or {'include_events': False})

                except Exception as e:
                    logger.error(f"Error collecting {report_type} data: {str(e)}")
                    report_data[f'include_{report_type}'] = False

            # Send the email
            smtp_settings = {
                'host': mail_config.smtp_server,
                'port': mail_config.smtp_port,
                'username': mail_config.username,
                'password': mail_config.password,
                'from_addr': mail_config.from_email.strip(),
                'from_name': mail_config.from_name,
                'provider': mail_config.provider
            }

            # Validate the emails
            valid_emails = self.validate_emails([email] if isinstance(email, str) else email)
            if not valid_emails:
                logger.error("No valid email addresses found")
                return False

            # Before rendering the template, ensure all values are initialized correctly
            for key in report_data:
                if isinstance(report_data[key], dict):
                    for subkey in report_data[key]:
                        if report_data[key][subkey] is None:
                            report_data[key][subkey] = 0

            # Send email with attachments
            success, message = send_email(
                html_content=render_template('dashboard/mail/report.html', **report_data),
                to_addr=valid_emails[0],
                subject=f"{SERVER_NAME} UPS Report {from_date.strftime('%Y-%m-%d')} to {to_date.strftime('%Y-%m-%d')}",
                smtp_settings=smtp_settings,
                attachments=attachments
            )

            return success

        except Exception as e:
            logger.error(f"Error generating and sending report: {str(e)}")
            return False

    def _generate_chart_image(self, data, chart_type, is_hourly=False):
        try:
            if not data:
                logger.info(f"{chart_type} chart: No data available")
                return ""
            
            # Initialize fig as None to avoid errors
            fig = None
            
            if chart_type == 'voltage':
                fig = go.Figure()
                
                # Handle the data format from voltage module
                available_series = []
                
                # Check for output_voltage (solo se realmente disponibile)
                if 'output_voltage' in data and len(data['output_voltage']) > 0:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['output_voltage']]
                    y = [point['value'] for point in data['output_voltage']]
                    
                    # Check if we have valid values
                    if any(val > 0 for val in y):
                        # Check if all values are the same
                        if len(set(y)) > 1:  # More than one unique value
                            fig.add_trace(
                                go.Scatter(
                                    x=x,
                                    y=y,
                                    name="Output Voltage",
                                    line=dict(color="#10b981")
                                )
                            )
                            available_series.append("Output Voltage")
                        else:
                            # Even if all values are the same, add a horizontal line for output voltage
                            fig.add_trace(
                                go.Scatter(
                                    x=[x[0], x[-1]],
                                    y=[y[0], y[0]],
                                    name="Output Voltage (Constant)",
                                    line=dict(color="#10b981", dash="dash")
                                )
                            )
                            available_series.append("Output Voltage (Constant)")
                            logger.debug(f"Added constant output_voltage line at {y[0]}")
                
                # Check for input_voltage (solo se realmente disponibile)
                if 'input_voltage' in data and len(data['input_voltage']) > 0:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['input_voltage']]
                    y = [point['value'] for point in data['input_voltage']]
                    
                    # Check if we have valid values
                    if any(val > 0 for val in y):
                        # Check if all values are the same
                        if len(set(y)) > 1:  # More than one unique value
                            fig.add_trace(
                                go.Scatter(
                                    x=x,
                                    y=y,
                                    name="Input Voltage",
                                    line=dict(color="#2563eb")
                                )
                            )
                            available_series.append("Input Voltage")
                        else:
                            # Even if all values are the same, add a horizontal line
                            fig.add_trace(
                                go.Scatter(
                                    x=[x[0], x[-1]],
                                    y=[y[0], y[0]],
                                    name="Input Voltage (Constant)",
                                    line=dict(color="#2563eb", dash="dash")
                                )
                            )
                            available_series.append("Input Voltage (Constant)")
                            logger.debug(f"Added constant input_voltage line at {y[0]}")
                
                # Check for transfer thresholds
                if 'input_transfer_high' in data and 'input_transfer_low' in data:
                    if len(data['input_transfer_high']) > 0 and len(data['input_transfer_low']) > 0:
                        x_high = [datetime.fromisoformat(point['timestamp']) for point in data['input_transfer_high']]
                        y_high = [point['value'] for point in data['input_transfer_high']]
                        
                        x_low = [datetime.fromisoformat(point['timestamp']) for point in data['input_transfer_low']]
                        y_low = [point['value'] for point in data['input_transfer_low']]
                        
                        # Add transfer thresholds as horizontal lines only if values are greater than 0
                        if len(y_high) > 0 and y_high[0] > 0:
                            fig.add_trace(
                                go.Scatter(
                                    x=[x_high[0], x_high[-1]],
                                    y=[y_high[0], y_high[0]],
                                    name="Transfer High",
                                    line=dict(color="#ef4444", dash="dash")
                                )
                            )
                        available_series.append("Transfer High")
                        
                        if len(y_low) > 0 and y_low[0] > 0:
                            fig.add_trace(
                                go.Scatter(
                                    x=[x_low[0], x_low[-1]],
                                    y=[y_low[0], y_low[0]],
                                    name="Transfer Low",
                                    line=dict(color="#f59e0b", dash="dash")
                                )
                            )
                        available_series.append("Transfer Low")
                
                # If no series were added, return empty string
                if not available_series:
                    logger.warning("No voltage series available for chart")
                    return ""
                
                # Update layout
                fig.update_layout(
                    title="Voltage Monitoring",
                    xaxis_title="Time",
                    yaxis_title="Voltage (V)",
                    legend_title="Metrics",
                    height=500,
                    template="plotly_white",
                    margin=dict(l=50, r=50, t=50, b=50),
                    hovermode="x unified",
                    legend=dict(
                        orientation="h",
                        yanchor="bottom",
                        y=1.02,
                        xanchor="right",
                        x=1
                    )
                )
                
            elif chart_type == 'power':
                # Chart with two axes for power and voltage
                fig = make_subplots(specs=[[{"secondary_y": True}]])
                
                # Add the power line (primary Y axis)
                if 'ups_realpower' in data:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['ups_realpower']]
                    y = [point['value'] for point in data['ups_realpower']]
                    fig.add_trace(
                        go.Scatter(
                            x=x,
                            y=y,
                            name="Real Power",
                            line=dict(color="#2563eb")
                        ),
                        secondary_y=False
                    )
                
                # Add the voltage line (secondary Y axis)
                if 'input_voltage' in data:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['input_voltage']]
                    y = [point['value'] for point in data['input_voltage']]
                    fig.add_trace(
                            go.Scatter(
                                x=x,
                                y=y,
                                name="Input Voltage",
                                line=dict(color="#10b981")
                            ),
                            secondary_y=True
                        )
                
                # If input_voltage is not available, try output_voltage
                elif 'output_voltage' in data:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['output_voltage']]
                    y = [point['value'] for point in data['output_voltage']]
                    fig.add_trace(
                        go.Scatter(
                            x=x,
                            y=y,
                            name="Output Voltage",
                            line=dict(color="#10b981")
                        ),
                        secondary_y=True
                    )
                
                # Update the layout
                fig.update_layout(
                    title="Power Analysis",
                    xaxis_title="Time",
                    yaxis_title="Real Power (W)",
                    yaxis2_title="Voltage (V)",
                    plot_bgcolor='white',
                    paper_bgcolor='white',
                    font=dict(size=12),
                    height=500,
                    template="plotly_white",
                    margin=dict(l=50, r=50, t=50, b=50),
                    hovermode="x unified",
                    legend=dict(
                        orientation="h",
                        yanchor="bottom",
                        y=1.02,
                        xanchor="right",
                        x=1
                    )
                )
                
            elif chart_type == 'battery':
                # Create a figure with secondary y-axis
                fig = make_subplots(specs=[[{"secondary_y": True}]])
                
                # Add battery charge (primary Y axis)
                if 'battery_charge' in data:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['battery_charge']]
                    y = [point['value'] for point in data['battery_charge']]
                    fig.add_trace(
                        go.Scatter(
                            x=x,
                            y=y,
                            name="Battery Charge (%)",
                            line=dict(color="#2563eb")
                        ),
                        secondary_y=False
                    )
                
                # Add battery runtime (secondary Y axis)
                if 'battery_runtime' in data:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['battery_runtime']]
                    # Convert seconds to minutes for better readability
                    y = [point['value'] / 60 for point in data['battery_runtime']]
                    fig.add_trace(
                        go.Scatter(
                            x=x,
                            y=y,
                            name="Runtime (min)",
                            line=dict(color="#10b981")
                        ),
                        secondary_y=True
                    )
                
                # Add battery voltage if available
                if 'battery_voltage' in data:
                    x = [datetime.fromisoformat(point['timestamp']) for point in data['battery_voltage']]
                    y = [point['value'] for point in data['battery_voltage']]
                    fig.add_trace(
                        go.Scatter(
                            x=x,
                            y=y,
                            name="Battery Voltage (V)",
                            line=dict(color="#f59e0b", dash="dash")
                        ),
                        secondary_y=True
                    )
                
                # Update the layout
                fig.update_layout(
                    title="Battery Performance",
                    xaxis_title="Time",
                    yaxis_title="Charge (%)",
                    yaxis2_title="Runtime (min) / Voltage (V)",
                    plot_bgcolor='white',
                    paper_bgcolor='white',
                    font=dict(size=12),
                    height=500,
                    template="plotly_white",
                    margin=dict(l=50, r=50, t=50, b=50),
                    hovermode="x unified",
                    legend=dict(
                        orientation="h",
                        yanchor="bottom",
                        y=1.02,
                        xanchor="right",
                        x=1
                    )
                )
            
            elif chart_type == 'energy':
                # For energy, we need to handle the data differently
                # The data can come in different formats
                fig = go.Figure()
                
                # Get currency from variable_config
                variable_config = VariableConfig.query.first()
                currency = variable_config.currency if variable_config else '€'
                
                # Get the energy cost rate
                energy_rate = get_energy_rate()
                
                # Determine if we should use hourly or daily bars based on is_hourly parameter
                time_format = '%H:%M' if is_hourly else '%d/%m'
                energy_title = "Hourly Energy Consumption" if is_hourly else "Daily Energy Consumption"
                
                # Check the format of the data
                # It could be a dictionary with 'data', 'from_date', 'to_date' keys
                if isinstance(data, dict) and 'data' in data and 'from_date' in data and 'to_date' in data:
                    # This is the format from _get_energy_report_data
                    cost_trend = data.get('data', [])
                    from_date = data.get('from_date')
                    to_date = data.get('to_date')
                
                if is_hourly:
                    # For hourly data, we need to retrieve the actual values from the tables
                    UPSDynamicData = get_ups_model()
                    
                    # Ensure that from_date and to_date cover the entire day
                    day_date = from_date.date()
                    if from_date.hour == 0 and from_date.minute == 0 and to_date.hour == 23 and to_date.minute == 59:
                        logger.debug("Using full day range for hourly data")
                    else:
                        logger.debug("Adjusting to full day range for consistency")
                        from_date = datetime.combine(day_date, datetime.min.time(), tzinfo=from_date.tzinfo)
                        to_date = datetime.combine(day_date, datetime.max.time(), tzinfo=to_date.tzinfo)
                    
                    # Retrieve the hours from the start of the day to the end (or from the specified range)
                    hour_data = UPSDynamicData.query.filter(
                        UPSDynamicData.timestamp_tz >= from_date,
                        UPSDynamicData.timestamp_tz <= to_date,
                        UPSDynamicData.ups_realpower_hrs.isnot(None)
                    ).order_by(UPSDynamicData.timestamp_tz.asc()).all()
                    
                    if hour_data:
                        logger.debug(f"Found {len(hour_data)} hourly data points")
                        hours = []
                        values = []
                        
                        for entry in hour_data:
                            hour_str = entry.timestamp_tz.strftime('%H:00')
                            energy_wh = float(entry.ups_realpower_hrs) if entry.ups_realpower_hrs is not None else 0
                            hours.append(hour_str)
                            values.append(energy_wh)
                        
                        # Calculate the cost for each hour
                        costs = [(v / 1000) * energy_rate for v in values]  # Convert Wh to kWh for cost calculation
                        
                        # Calculate the total energy and cost
                        total_energy = sum(values)
                        total_cost = sum(costs)
                            
                        fig.add_trace(go.Bar(
                            x=hours,
                            y=values,
                            name='Energy Consumption',
                            marker_color='#3366CC'
                        ))
                        
                        fig.update_layout(
                            xaxis_title="Hour",
                            yaxis_title="Energy (Wh)",
                            bargap=0.2
                        )
                    else:
                        # Fallback: if no hourly data is found, distribute the total energy uniformly
                        logger.debug("No hourly data found, using uniform distribution")
                        hours = []
                        values = []
                        
                        # Get the total energy from the energy_data
                        total_energy = 0
                        if cost_trend:
                            # Sum the cost values and convert back to energy
                            total_cost = sum(point[1] for point in cost_trend)
                            total_energy = (total_cost / energy_rate) * 1000  # Convert from cost to kWh to Wh
                        
                        # Prepare an array of 24 hours for a full day
                        for hour in range(24):
                            hour_str = f"{hour:02d}:00"
                            # Distribute the total energy over 24 hours
                            value = total_energy / 24
                            hours.append(hour_str)
                            values.append(value)
                        
                        fig.add_trace(go.Bar(
                            x=hours,
                            y=values,
                            name='Energy Consumption',
                            marker_color='#3366CC'
                        ))
                        
                        fig.update_layout(
                            xaxis_title="Hour",
                            yaxis_title="Energy (Wh)",
                            bargap=0.2
                        )
                else:
                    # For daily data, use the cost_trend data
                    if cost_trend and isinstance(cost_trend, list):
                        dates = []
                        values = []
                        
                        # Calculate the duration in days
                        duration_days = (to_date.date() - from_date.date()).days
                        
                        if duration_days > 30:
                            # For long periods, group by month
                            monthly_data = {}
                            
                            for point in cost_trend:
                                if isinstance(point, list) and len(point) >= 2:
                                    # Format: [timestamp, value]
                                    timestamp = datetime.fromtimestamp(point[0]/1000, from_date.tzinfo)
                                    value = point[1]
                                    
                                    month_key = timestamp.strftime('%Y-%m')
                                    if month_key not in monthly_data:
                                        monthly_data[month_key] = 0
                                    monthly_data[month_key] += value
                                
                                # Sort the months chronologically
                            sorted_months = sorted(monthly_data.keys())
                            month_labels = [datetime.strptime(m, '%Y-%m').strftime('%b %Y') for m in sorted_months]
                            month_values = [monthly_data[m] for m in sorted_months]
                            
                            # Convert cost to energy
                            energy_values = [(v / energy_rate) * 1000 for v in month_values]  # Convert from cost to kWh to Wh
                            
                            fig.add_trace(go.Bar(
                                x=month_labels,
                                y=energy_values,
                                name='Monthly Energy',
                                marker_color='#3366CC'
                            ))
                            
                            fig.update_layout(
                                xaxis_title="Month",
                                yaxis_title="Energy (Wh)",
                                bargap=0.2
                            )
                        else:
                            # For shorter periods, show daily data
                            current_date = from_date
                            while current_date <= to_date:
                                date_str = current_date.strftime('%Y-%m-%d')
                                display_date = current_date.strftime('%d/%m')
                                
                                # Find the cost for this day
                                day_cost = 0
                                for point in cost_trend:
                                    if isinstance(point, list) and len(point) >= 2:
                                        point_time = datetime.fromtimestamp(point[0]/1000, current_date.tzinfo)
                                        if point_time.date() == current_date.date():
                                            day_cost = point[1]
                                            break
                                
                                # Convert cost to energy
                                day_energy = (day_cost / energy_rate) * 1000  # Convert from cost to kWh to Wh
                                
                                dates.append(display_date)
                                values.append(day_energy)
                                current_date += timedelta(days=1)
                            
                            fig.add_trace(go.Bar(
                                x=dates,
                                y=values,
                                name='Energy Consumption',
                                marker_color='#3366CC'
                            ))
                            
                            fig.update_layout(
                                xaxis_title="Date",
                                yaxis_title="Energy (Wh)",
                                bargap=0.2
                            )
                    elif 'energy' in data:
                        # This is the format with explicit 'energy' key
                        x_dates = [datetime.fromisoformat(point['timestamp']) for point in data['energy']]
                        y_values = [point['value'] for point in data['energy']]
                        
                        # Format x-axis labels based on hourly or daily
                        x_labels = [dt.strftime(time_format) for dt in x_dates]
                        
                        fig.add_trace(go.Bar(
                            x=x_labels,
                            y=y_values,
                            name="Energy (Wh)",
                            marker_color="#3366CC"
                        ))
                        
                        # Add cost as a line on top of bars if available
                        if 'cost' in data:
                            x_dates = [datetime.fromisoformat(point['timestamp']) for point in data['cost']]
                            y_values = [point['value'] for point in data['cost']]
                            
                            # Format x-axis labels based on hourly or daily
                            x_labels = [dt.strftime(time_format) for dt in x_dates]
                            
                        fig.add_trace(go.Scatter(
                            x=x_labels,
                            y=y_values,
                            name=f"Cost ({currency})",
                            line=dict(color="#10b981", width=3),
                            mode='lines+markers'
                        ))
                
                # Update the layout
                fig.update_layout(
                title=energy_title,  # Use the energy_title variable instead of title_text
                xaxis_title="Time" if is_hourly else "Date",
                yaxis_title="Energy (Wh)",
                    plot_bgcolor='white',
                    paper_bgcolor='white',
                    font=dict(size=12),
                height=500,
                template="plotly_white",
                    margin=dict(l=50, r=50, t=50, b=50),
                hovermode="x unified",
                bargap=0.2,
                showlegend=False  # Remove the legend to gain space
            )
        
            # If fig is still None, it means the chart type is not supported
            if fig is None:
                logger.warning(f"Unsupported chart type: {chart_type}")
                return ""
        
            # Convert the chart to an image with high quality settings
            img_bytes = fig.to_image(
                format="png",
                width=1000,
                height=600,
                scale=2
            )
            img_base64 = base64.b64encode(img_bytes).decode('utf-8')
            
            logger.info(f"{chart_type} chart: Generated successfully")
            return f"data:image/png;base64,{img_base64}"
            
        except Exception as e:
            logger.error(f"Error generating {chart_type} chart: {str(e)}", exc_info=True)
            return ""

    def _debug_mail_config(self):
        """Debug mail configuration"""
        try:
            config = MailConfig.query.first()
            if config:
                logger.info(f"Mail config found: SMTP={config.smtp_server}:{config.smtp_port}")
                logger.info(f"From: {config.from_name} <{config.from_email}>")
                logger.info(f"Enabled: {config.enabled}")
                return True
            else:
                logger.error("No mail configuration found")
                return False
        except Exception as e:
            logger.error(f"Error checking mail config: {str(e)}")
            return False

    def validate_emails(self, emails: List[str]) -> List[str]:
        """Validate email addresses"""
        valid_emails = []
        for email in emails:
            try:
                valid = validate_email(email.strip())
                valid_emails.append(valid.email)
            except EmailNotValidError as e:
                logger.warning(f"Invalid email: {email} - {str(e)}")
        return valid_emails

def get_current_email_settings():
    """Get current email settings from MailConfig"""
    try:
        mail_config = MailConfig.query.first()
        if mail_config and mail_config.enabled:
            return mail_config.from_email
        return None
    except Exception as e:
        logger.error(f"Error getting email settings: {str(e)}")
        return None

report_manager = ReportManager() 

def save_schedule():
    """Save a new report schedule"""
    try:
        data = request.get_json()
        logger.info(f"📝 Saving schedule with data: {data}")
        
        # Validate required fields
        if not all(k in data for k in ['time', 'days', 'reports', 'period_type']):
            logger.error("❌ Missing required fields")
            return jsonify({
                'success': False,
                'message': 'Missing required fields'
            }), 400
        
        # Generate cron expression
        time_parts = data['time'].split(':')
        
        # Check if days is available and not empty
        if 'days' in data and data['days']:
            days_str = ','.join(str(d) for d in data['days'])
        else:
            days_str = '*'
            
        cron_expr = f"{time_parts[1]} {time_parts[0]} * * {days_str}"
        
        # Use the existing schedule_report method
        success = report_manager.schedule_report(
            cron_expression=cron_expr,
            report_types=data['reports'],
            email=data['email'] or get_current_email_settings(),
            period_type=data['period_type']
        )
            
        if success:
            logger.info("✅ Schedule created successfully")
            return jsonify({
                'success': True,
                'message': 'Schedule saved successfully',
                'id': report_manager.last_schedule_id  # Add this property to ReportManager
            })
        else:
            logger.error("❌ Failed to create schedule")
            return jsonify({
                'success': False,
                'message': 'Failed to add job to scheduler'
            }), 500
            
    except Exception as e:
        logger.error(f"❌ Error saving schedule: {str(e)}")
        return jsonify({
            'success': False,
            'message': 'Failed to create schedule'
        }), 500 