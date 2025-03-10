class MainPage extends BasePage {
    /**
     * Constructor - Initializes the main dashboard page
     * - Enables logging
     * - Sets up timezone
     * - Sets up real-time monitoring for all widgets
     */
    constructor() {
        super();
        webLogger.enable(false);
        this._timezone = this.getConfiguredTimezone();
        this.updateInterval = null;
        this.powerChart = null;
        this.dataBuffer = []; // Buffer for real-time data
        this.bufferSize = 15; // Increased from 10 to 15 for better smoothing
        this.init();
    }

    async init() {
        webLogger.page('Initializing main dashboard');
        await this.initializePowerChart();
        await this.loadInitialData();
        this.startRealTimeUpdates();
    }

    async initializePowerChart() {
        const ctx = document.getElementById('performanceChart').getContext('2d');
        
        try {
            // Take the last 5 minutes of historical data instead of 60 seconds
            const now = new Date();
            const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);
            
            const response = await fetch('/api/power/history?period=day' + 
                '&from_time=' + fiveMinutesAgo.toTimeString().slice(0, 5) +
                '&to_time=' + now.toTimeString().slice(0, 5));
            const result = await response.json();
            
            let initialData = [];
            if (result.success && result.data && result.data.ups_realpower) {
                initialData = result.data.ups_realpower.map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: point.value
                }));
                webLogger.console('Loaded historical data:', initialData);
                
                // If not enough historical data, generate synthetic data
                if (initialData.length < 10) {
                    initialData = this.generateSyntheticData(now);
                }
                
                // Initialize the buffer with the last points
                this.dataBuffer = initialData.slice(-this.bufferSize);
            } else {
                // Generate synthetic data if no historical data is available
                initialData = this.generateSyntheticData(now);
                this.dataBuffer = initialData.slice(-this.bufferSize);
            }

            // Create a gradient for the fill under the line
            const gradient = ctx.createLinearGradient(0, 0, 0, 300);
            gradient.addColorStop(0, 'rgba(0, 200, 83, 0.3)');
            gradient.addColorStop(1, 'rgba(0, 200, 83, 0.0)');

            // Common chart configuration
            const chartConfig = {
                type: 'line',
                data: {
                    datasets: [{
                        label: 'Real Power',
                        backgroundColor: gradient,
                        borderColor: '#00c853',
                        borderWidth: 2.5,
                        data: initialData,
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true,
                        cubicInterpolationMode: 'monotone'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        streaming: {
                            duration: 60000, // Show only 60 seconds
                            refresh: 1000,
                            delay: 1000,
                            onRefresh: this.onRefresh.bind(this)
                        },
                        zoom: {
                            pan: {
                                enabled: true,
                                mode: 'xy', // Allow movement on both axes
                                speed: 10,
                                threshold: 10
                            },
                            zoom: {
                                enabled: true,
                                mode: 'xy', // Allow zoom on both axes
                                speed: 0.1,
                                sensitivity: 3,
                                onZoom: function({ chart }) {
                                    webLogger.console('Zoomed!', chart);
                                },
                                onPan: function({ chart }) {
                                    webLogger.console('Panned!', chart);
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'realtime',
                            time: {
                                unit: 'second',
                                displayFormats: {
                                    second: 'HH:mm:ss'
                                }
                            },
                            grid: { display: false },
                            ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 20 }
                        },
                        y: {
                            min: 0, // Set a fixed minimum at 0 instead of a dynamic value
                            max: (context) => {
                                if (context.chart.data.datasets[0].data.length > 0) {
                                    let maxValue = Math.max(...context.chart.data.datasets[0].data.map(d => d.y));
                                    // Guarantee a maximum of at least 100W to always display the chart
                                    return Math.max(100, Math.ceil(maxValue * 1.2));
                                }
                                return 100;
                            },
                            grid: {
                                display: false
                            },
                            ticks: {
                                stepSize: 20,
                                color: '#00c853'
                            },
                            title: {
                                display: true,
                                text: 'Power (W)',
                                color: '#ffffff'
                            }
                        }
                    },
                    interaction: {
                        intersect: false,
                        mode: 'nearest'
                    },
                    animation: {
                        duration: 1000, // Increased from 500 to 1000 for smoother animations
                        easing: 'easeOutQuart' // Changed from easeInOutCubic to easeOutQuart for a more natural effect
                    }
                }
            };

            this.powerChart = new Chart(ctx, chartConfig);
            webLogger.console('Chart initialized with data');

        } catch (error) {
            console.error('Error initializing power chart:', error);
            this.initializeEmptyChart(ctx);
        }
    }

    // New method to generate synthetic data
    generateSyntheticData(endTime) {
        const data = [];
        const lastKnownValue = this.getLastKnownPowerValue() || 100; // Default value if not available
        
        // Generate 30 points in the last 5 minutes with small variations
        for (let i = 0; i < 30; i++) {
            const time = new Date(endTime - (30 - i) * 10000); // One point every 10 seconds
            // Add a small random variation to the value
            const variation = Math.random() * 20 - 10; // ±10W variation
            const value = Math.max(lastKnownValue + variation, 10); // Ensure a minimum of 10W
            
            data.push({
                x: time.getTime(),
                y: value
            });
        }
        
        return data;
    }

    // New method to get the last known power value
    getLastKnownPowerValue() {
        // Try to get the last value from cache or localStorage
        const cachedValue = localStorage.getItem('lastPowerValue');
        if (cachedValue) {
            return parseFloat(cachedValue);
        }
        
        // Default value if not available
        return 100;
    }

    initializeEmptyChart(ctx) {
        // Create a gradient for the fill under the line
        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, 'rgba(0, 200, 83, 0.3)');
        gradient.addColorStop(1, 'rgba(0, 200, 83, 0.0)');
        
        // Use the same configuration but with empty data
        this.powerChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Real Power',
                    backgroundColor: gradient,
                    borderColor: '#00c853',
                    borderWidth: 2.5,
                    data: [],
                    pointRadius: 0,
                    tension: 0.4,
                    fill: true,
                    cubicInterpolationMode: 'monotone'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    streaming: {
                        duration: 300000,
                        refresh: 1000,
                        delay: 1000,
                        onRefresh: this.onRefresh.bind(this)  // Use the same onRefresh
                    },
                    zoom: {
                        pan: {
                            enabled: true,
                            mode: 'xy', // Allow movement on both axes
                            speed: 10,
                            threshold: 10
                        },
                        zoom: {
                            enabled: true,
                            mode: 'xy', // Allow zoom on both axes
                            speed: 0.1,
                            sensitivity: 3,
                            onZoom: function({ chart }) {
                                webLogger.console('Zoomed!', chart);
                            },
                            onPan: function({ chart }) {
                                webLogger.console('Panned!', chart);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'realtime',
                        grid: { display: false },
                        ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 20 }
                    },
                    y: {
                        min: 0, // Set a fixed minimum at 0
                        max: (context) => {
                            if (context.chart.data.datasets[0].data.length > 0) {
                                let maxValue = Math.max(...context.chart.data.datasets[0].data.map(d => d.y));
                                return Math.max(100, Math.ceil(maxValue * 1.2));
                            }
                            return 100;
                        },
                        grid: {
                            display: false
                        },
                        ticks: {
                            stepSize: 20,
                            color: '#00c853'
                        },
                        title: {
                            display: true,
                            text: 'Power (W)',
                            color: '#ffffff'
                        }
                    }
                },
                interaction: {
                    intersect: false,
                    mode: 'nearest'
                },
                animation: {
                    duration: 1000,
                    easing: 'easeOutQuart'
                }
            }
        });
        webLogger.console('Empty chart initialized as fallback');
    }

    async loadInitialData() {
        webLogger.data('🔄 Loading initial data');
        
        try {
            // Load data from UPS cache, events, notifications and schedules
            const [cacheData, eventsData, notifySettings, scheduleResponse] = await Promise.all([
                fetch('/api/ups/cache').then(r => r.json()),
                fetch('/api/table/events?limit=5').then(r => r.json()),
                fetch('/api/settings/nutify').then(r => r.json()),
                fetch('/api/settings/report/schedules').then(r => r.json())
            ]);
            
            // Log detailed events data
            webLogger.data('📋 Events data:', eventsData);
            
            // Update dashboard with UPS cache data
            if (cacheData.success && Array.isArray(cacheData.data) && cacheData.data.length > 1) {
                const data = cacheData.data[1];
                this.updateDashboard(data);
            }
            
            // Correct event handling
            if (eventsData && eventsData.rows) {
                const events = eventsData.rows;
                if (Array.isArray(events) && events.length > 0) {
                    this.updateRecentEvents(events);
                }
            }
            
            // Update alerts and schedules
            if (notifySettings.success && notifySettings.data) {
                const schedules = scheduleResponse.success ? scheduleResponse.data : [];
                this.updateActiveAlertsAndSchedules(notifySettings.data, schedules);
            }
            
        } catch (error) {
            webLogger.error('Error loading initial data:', error);
        }
    }

    startRealTimeUpdates() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }

        this.updateInterval = setInterval(() => {
            this.loadRealTimeData();
        }, 1000);

        this.loadRealTimeData();
    }

    updateDashboard(data) {
        webLogger.data('🔄 Updating dashboard with data:', data);
        
        try {
            // Update main metrics
            webLogger.data('📊 Updating metrics');
            this.updateMetrics(data);
            
            webLogger.data('✅ Dashboard update completed');
        } catch (error) {
            webLogger.error('❌ Error in updateDashboard:', error);
        }
    }

    updateMetrics(data) {
        webLogger.data('📊 Updating metrics with data:', data);
        
        try {
            const metrics = {
                battery: data.battery_charge,
                runtime: data.battery_runtime / 60,
                power: data.ups_realpower,
                load: data.ups_load
            };

            webLogger.data('📊 Metrics to update:', metrics);

            Object.entries(metrics).forEach(([type, value]) => {
                webLogger.data(`📊 Updating metric ${type} with value ${value}`);
                this.updateMetricValue(type, value);
            });

            webLogger.data('✅ Metrics updated successfully');
        } catch (error) {
            webLogger.error('❌ Error updating metrics:', error);
        }
    }

    updateMetricValue(type, value) {
        const element = document.querySelector(`.stat-value[data-type="${type}"]`);
        if (!element) return;

        let formattedValue = '--';
        if (value !== undefined && value !== null) {
            switch(type) {
                case 'battery':
                    formattedValue = `${parseFloat(value).toFixed(1)}%`;
                    break;
                case 'runtime':
                    formattedValue = `${Math.floor(value)} min`;
                    break;
                case 'power':
                    formattedValue = `${parseFloat(value).toFixed(1)}W`;
                    break;
                case 'load':
                    formattedValue = `${parseFloat(value).toFixed(1)}%`;
                    break;
            }
        }

        element.textContent = formattedValue;
    }

    formatUPSStatus(status) {
        if (!status) return 'Unknown';
        
        const states = {
            'OL': 'Online',
            'OB': 'On Battery',
            'LB': 'Low Battery',
            'HB': 'High Battery',
            'RB': 'Replace Battery',
            'CHRG': 'Charging',
            'DISCHRG': 'Discharging',
            'BYPASS': 'Bypass Mode',
            'CAL': 'Calibration',
            'OFF': 'Offline',
            'OVER': 'Overloaded',
            'TRIM': 'Trimming Voltage',
            'BOOST': 'Boosting Voltage'
        };

        return status.split(' ')
            .map(s => states[s] || s)
            .join(' + ');
    }

    cleanup() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        if (this.powerChart) {
            this.powerChart.destroy();
        }
    }

    updateRecentEvents(events) {
        webLogger.data('[DEBUG] updateRecentEvents called with events:', events);
        const container = document.getElementById('recentEvents');
        if (!container) {
            webLogger.error('No element with id "recentEvents" found.');
            return;
        }

        // Check if events is an array and has elements
        if (!Array.isArray(events) || events.length === 0) {
            container.innerHTML = '<div class="no-events">No recent events</div>';
            return;
        }

        // Format events
        container.innerHTML = events.map(event => `
            <div class="event-item ${event.event_type ? event.event_type.toLowerCase() : 'unknown'}">
                <div class="event-icon">
                    <i class="fas ${this.getEventIcon(event.event_type)}"></i>
                </div>
                <div class="event-content">
                    <div class="event-header">
                        <span class="event-type">${this.formatEventType(event.event_type)}</span>
                        <span class="event-time">${this.formatEventTime(event.timestamp_tz_begin)}</span>
                    </div>
                    <div class="event-status ${event.acknowledged ? 'seen' : 'new'}">
                        ${event.acknowledged ? 'Seen' : 'New'}
                    </div>
                </div>
            </div>
        `).join('');
    }

    updateActiveAlertsAndSchedules(notifications, schedules) {
        const container = document.getElementById('activeAlerts');
        if (!container) return;

        // Log per debug
        webLogger.data('📅 Updating alerts and schedules:', { notifications, schedules });

        // Filter only active notifications
        const activeNotifications = notifications.filter(n => n.enabled);

        // Filter only enabled schedules
        const activeSchedules = schedules ? schedules.filter(s => s.enabled) : [];

        // Create the container for alerts and schedules
        container.innerHTML = `
            <div class="alerts-section">
                ${activeNotifications.length === 0 ? 
                    '<div class="no-alerts">No active alerts</div>' :
                    '<div class="alerts-grid">' + 
                    activeNotifications.map(notification => `
                        <div class="alert-item ${this.getAlertSeverity(notification.event_type)}">
                            <div class="alert-icon">
                                <i class="fas ${this.getAlertIcon(notification.event_type)}"></i>
                            </div>
                            <div class="alert-content">
                                <div class="alert-title">${this.formatEventType(notification.event_type)}</div>
                            </div>
                            <div class="alert-status">
                                <i class="fas fa-circle"></i>
                            </div>
                        </div>
                    `).join('') + '</div>'
                }
            </div>
            <div class="schedules-section">
                <div class="section-header">
                    <i class="fas fa-calendar"></i> Active Schedules
                </div>
                <div class="schedules-grid">
                    ${activeSchedules.length > 0 ? activeSchedules.map(schedule => `
                        <div class="schedule-item">
                            <div class="schedule-icon">
                                <i class="fas fa-clock"></i>
                            </div>
                            <div class="schedule-content">
                                <div class="schedule-title">${schedule.time}</div>
                                <div class="schedule-days">${this.formatScheduleDays(schedule.days)}</div>
                                <div class="schedule-reports">${schedule.reports.join(', ')}</div>
                            </div>
                        </div>
                    `).join('') : '<div class="no-schedules">No active schedules</div>'}
                </div>
            </div>
        `;
    }

    formatScheduleDays(days) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return days.map(d => dayNames[d]).join(', ');
    }

    initSocketListeners() {
        if (typeof io !== 'undefined') {
            const socket = io();
            
            socket.on('connect', () => {
                webLogger.data('🔌 Socket connected');
            });

            // Listen for event updates
            socket.on('event_update', (eventData) => {
                webLogger.data('📩 Received event update:', eventData);
                // Reload events when a new one arrives
                this.handleNewEvent(eventData);
            });

            // Listen for notification updates
            socket.on('notification_update', (data) => {
                webLogger.data('Received notification update:', data);
                this.updateActiveAlerts(data);
            });
        }
    }

    // Helper methods
    formatEventTime(timestamp) {
        return new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: this._timezone
        });
    }

    formatEventType(type) {
        const types = {
            'ONBATT': 'On Battery',
            'ONLINE': 'Online',
            'LOWBATT': 'Low Battery',
            'COMMOK': 'Communication OK',
            'COMMBAD': 'Communication Lost',
            'SHUTDOWN': 'Shutdown',
            'REPLBATT': 'Replace Battery'
        };
        return types[type] || type;
    }

    getAlertIcon(severity) {
        const icons = {
            'critical': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        };
        return icons[severity.toLowerCase()] || 'fa-bell';
    }

    getEventIcon(type) {
        const icons = {
            'ONBATT': 'fa-battery-quarter',
            'ONLINE': 'fa-plug',
            'LOWBATT': 'fa-battery-empty',
            'COMMOK': 'fa-check-circle',
            'COMMBAD': 'fa-times-circle',
            'SHUTDOWN': 'fa-power-off',
            'REPLBATT': 'fa-exclamation-triangle'
        };
        return icons[type] || 'fa-info-circle';
    }

    calculateHealthPercentage(metric) {
        if (metric.label === 'Temperature') {
            return this.normalizeTemperature(metric.value);
        }
        return metric.value;
    }

    updateHealthGauge(id, value) {
        const gauge = document.getElementById(id);
        if (!gauge) return;

        const percentage = Math.min(Math.max(value, 0), 100);
        gauge.style.width = `${percentage}%`;
        gauge.style.backgroundColor = this.getHealthColor(percentage);
    }

    normalizeTemperature(temp) {
        if (!temp) return 0;
        // Assume 20-40°C range as normal operating temperature
        return Math.min(Math.max((temp - 20) * 5, 0), 100);
    }

    getHealthColor(value) {
        if (value >= 80) return '#10B981'; // Green
        if (value >= 60) return '#F59E0B'; // Yellow
        return '#EF4444'; // Red
    }

    getAlertSeverity(eventType) {
        const severityMap = {
            'LOWBATT': 'critical',
            'ONBATT': 'warning',
            'COMMBAD': 'critical',
            'NOCOMM': 'critical',
            'SHUTDOWN': 'critical',
            'REPLBATT': 'warning',
            'NOPARENT': 'warning'
        };
        return severityMap[eventType] || 'info';
    }

    handleNewEvent(event) {
        // Update the events list when a new one arrives
        fetch('/api/table/events?limit=5')
            .then(r => r.json())
            .then(data => {
                if (data.success && data.data) {
                    this.updateRecentEvents(data.data);
                }
            })
            .catch(error => webLogger.error('Error updating events:', error));
    }

    async loadRealTimeData() {
        try {
            const response = await fetch('/api/ups/cache');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const result = await response.json();
            if (result.success && result.data && Array.isArray(result.data)) {
                const data = result.data[1];
                this.updateDashboard(data);
            }
        } catch (error) {
            console.error('Error loading real-time data:', error);
        }
    }

    async updateUPSData() {
        try {
            const response = await fetch('/api/ups/cache');
            const result = await response.json();
            
            if (result.success && result.data && Array.isArray(result.data)) {
                const data = result.data[1];
                
                // Update status
                if (this.statusElement && data.ups_status) {
                    this.statusElement.innerHTML = `
                        <i class="fas fa-plug"></i>
                        <span id="upsStatus">${this.formatUPSStatus(data.ups_status)}</span>
                    `;
                }

                // Update battery
                if (this.batteryElement && data.battery_charge) {
                    this.batteryElement.innerHTML = `
                        <i class="fas fa-battery-three-quarters"></i>${parseFloat(data.battery_charge).toFixed(1)}%
                    `;
                }

                // Update load
                if (this.loadElement && data.ups_load) {
                    this.loadElement.innerHTML = `
                        <i class="fas fa-tachometer-alt"></i>${parseFloat(data.ups_load).toFixed(1)}%
                    `;
                }

                // Update power
                if (this.powerElement && data.ups_realpower) {
                    this.powerElement.innerHTML = `
                        <i class="fas fa-bolt"></i>${parseFloat(data.ups_realpower).toFixed(1)}W
                    `;
                }
            }
        } catch (error) {
            console.error('Error updating UPS data:', error);
        }
    }

    onRefresh(chart) {
        return fetch('/api/ups/cache')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data && Array.isArray(result.data)) {
                    const data = result.data[1];
                    let value = parseFloat(data.ups_realpower || 0);
                    
                    // Ensure the value is never zero or negative
                    value = Math.max(value, 1);
                    
                    const now = Date.now();

                    // Add the new point to the buffer
                    this.dataBuffer.push({
                        x: now,
                        y: value
                    });

                    // Maintain the buffer at the correct size
                    if (this.dataBuffer.length > this.bufferSize) {
                        this.dataBuffer.shift();
                    }

                    // Calculate the smoothed point using the buffer
                    const smoothedValue = this.calculateSmoothedValue();
                    
                    // Save the last value for future use
                    localStorage.setItem('lastPowerValue', value.toString());

                    // Add the smoothed point to the chart
                    chart.data.datasets[0].data.push({
                        x: now,
                        y: smoothedValue
                    });

                    // Update the chart color based on the value
                    this.updateChartColor(chart, smoothedValue);

                    chart.update('quiet');
                }
            })
            .catch(error => console.error('Error fetching power data:', error));
    }

    // New method to update the chart color based on the value
    updateChartColor(chart, value) {
        // Change the color based on the power level
        let color;
        if (value > 500) {
            color = '#ef4444'; // Red for high consumption
        } else if (value > 200) {
            color = '#f59e0b'; // Orange for medium consumption
        } else {
            color = '#00c853'; // Green for low consumption
        }
        
        chart.data.datasets[0].borderColor = color;
        
        // Update the gradient as well
        const ctx = chart.ctx;
        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, this.hexToRgba(color, 0.3));
        gradient.addColorStop(1, this.hexToRgba(color, 0.0));
        chart.data.datasets[0].backgroundColor = gradient;
    }

    // New method to convert a hex color to rgba
    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    calculateSmoothedValue() {
        if (this.dataBuffer.length === 0) return 0;
        
        // Use a more sophisticated smoothing algorithm
        // Weights for an advanced smoothing filter
        const weights = [];
        for (let i = 0; i < this.dataBuffer.length; i++) {
            // Formula to give more weight to more recent values
            weights.push(Math.pow(1.2, i));
        }
        
        const weightSum = weights.reduce((a, b) => a + b, 0);
        
        // Calculate the weighted average
        let smoothedValue = 0;
        for (let i = 0; i < this.dataBuffer.length; i++) {
            smoothedValue += this.dataBuffer[i].y * weights[i];
        }
        
        return smoothedValue / weightSum;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new MainPage();
    const chartCard = document.querySelector('.chart_card');
    if (chartCard) {
        chartCard.style.height = '320px';
        chartCard.style.paddingBottom = '20px';
    }
});
