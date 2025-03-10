class BatteryPage extends BasePage {
    constructor() {
        super();
        webLogger.enable(false);
        this.availableMetrics = null;
        this.isRealTimeMode = false;
        this.realTimeInterval = null;
        this.realTimeIntervalDuration = 1000;
        this.isFirstRealTimeUpdate = true;
        this.voltageController = null; // We will initialize it after creating the chart
        
        // Bind formatting functions
        this.formatChartDate = this.formatChartDate.bind(this);
        this.formatTooltipDate = this.formatTooltipDate.bind(this);
        
        this._timezone = this.getConfiguredTimezone();
        
        (async () => {
            try {
                await this.loadMetrics();
                this.initEventListeners();
                this.initCharts();
                
                // Check if there is data in the database
                const hasHistoricalData = await this.checkHistoricalData();
                if (!hasHistoricalData) {
                    this.startRealTimeMode();
                } else {
                    // If there is historical data, load today's data
                    const now = new Date();
                    const currentTime = now.toLocaleTimeString(
                        window.APP_CONFIG && window.APP_CONFIG.locale ? 
                        window.APP_CONFIG.locale : undefined, 
                        { hour: '2-digit', minute: '2-digit' }
                    );
                    
                    // Update UI
                    document.querySelectorAll('.range-options a').forEach(option => {
                        option.classList.remove('active');
                        if (option.dataset.range === 'today') {
                            option.classList.add('active');
                        }
                    });
                    
                    this.updateDisplayedRange(`Today (00:00 - ${currentTime})`);
                    await this.loadData('today', '00:00', currentTime);
                }
            } catch (error) {
                webLogger.error('Error in initialization:', error);
            }
        })();
    }
    
    async loadInitialCacheData() {
        try {
            const response = await fetch('/api/ups/cache');
            const result = await response.json();
            
            if (result.success && result.data && Array.isArray(result.data)) {
                const data = result.data[1];
                return {
                    // Include only available fields
                    battery_temperature: data.battery_temperature
                };
            }
            return null;
        } catch (error) {
            webLogger.error('Error loading battery cache data:', error);
            return null;
        }
    }

    async loadData(period = 'day', fromTime = null, toTime = null) {
        try {
            const params = new URLSearchParams();
            params.append('period', period);
            
            const selectedRange = document.querySelector('.range-options a.active');
            const rangeType = selectedRange ? selectedRange.dataset.range : 'day';
            
            webLogger.data("🔍 loadData called with:", { period, fromTime, toTime, rangeType });

            if (rangeType === 'day') {
                params.append('period', 'day');
                if (fromTime && !toTime) {
                    // SELECT DAY - pass the complete date
                    params.append('selected_date', fromTime);
                    webLogger.data('📅 Select Day mode', { date: fromTime });
                } else {
                    // TODAY - always pass the entire day
                    const now = new Date();
                    params.append('from_time', '00:00');
                    params.append('to_time', now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: this._timezone }));
                    webLogger.data('📅 Today mode', { from: '00:00', to: params.get('to_time') });
                }
            } else if (rangeType === 'range') {
                params.append('period', 'range');
                params.append('from_time', fromTime);
                params.append('to_time', toTime);
                webLogger.data('📅 Range mode', { from: fromTime, to: toTime });
            } else {
                // Other cases (realtime)
                if (fromTime) params.append('from_time', fromTime);
                if (toTime) params.append('to_time', toTime);
                webLogger.data('📅 Realtime mode', { from: fromTime, to: toTime });
            }

            const [statsResponse, historyResponse] = await Promise.all([
                fetch(`/api/battery/stats?${params}`),
                fetch(`/api/battery/history?${params}`)
            ]);

            const stats = await statsResponse.json();
            const history = await historyResponse.json();

            webLogger.data("📊 Received data:", {
                stats: stats.data,
                history: history.data,
                available_metrics: Object.keys(history.data || {}),
                temperature_present: history.data?.battery_temperature ? 'YES' : 'NO',
                num_temp_points: history.data?.battery_temperature?.length || 0
            });

            if (stats.success && history.success) {
                const formattedData = this.formatChartData(history.data);
                if (this.combinedChart) {
                    this.combinedChart.updateSeries([
                        {
                            name: 'Battery Level',
                            data: formattedData.battery_charge || [],
                            type: 'line',
                            color: '#2E93fA'
                        },
                        {
                            name: 'Runtime',
                            data: formattedData.battery_runtime || [],
                            type: 'line',
                            color: '#66DA26'
                        },
                        {
                            name: 'Voltage',
                            data: formattedData.battery_voltage || [],
                            type: 'line',
                            color: '#FF9800'
                        }
                    ]);
                }
                
                await this.updateStats(stats.data);
                webLogger.page('Page data updated successfully');
            } else {
                webLogger.error('API Error', { stats, history });
                this.showError('Error loading data from server');
            }
        } catch (error) {
            webLogger.error("❌ Error loading data:", error);
            console.error('Error loading data:', error);
            this.showError('Error loading data');
        }
    }

    formatChartData(data) {
        const formatted = {};
        
        // Format data for each metric
        ['battery_charge', 'battery_runtime', 'battery_voltage'].forEach(metric => {
            if (data[metric] && Array.isArray(data[metric])) {
                formatted[metric] = data[metric].map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: metric === 'battery_runtime' ? point.value / 60 : point.value // Convert runtime to minutes
                }));
            }
        });
        
        return formatted;
    }

    async loadMetrics() {
        try {
            const response = await fetch('/api/battery/metrics');
            const data = await response.json();
            if (data.success && data.data) {
                this.availableMetrics = data.data;
                webLogger.data('Available metrics', this.availableMetrics);
            }
        } catch (error) {
            webLogger.error('Error loading metrics', error);
        }
    }
    // CONTROLLER
    async initCharts() {
        webLogger.page('Initializing battery charts');
        
        const combinedChartElement = document.querySelector("#combinedBatteryChart");
        if (combinedChartElement) {
            this.initCombinedChart(combinedChartElement);
            // Initialize the voltage controller after creating the chart
            this.voltageController = new BatteryVoltageController(this.combinedChart);
        }

        // Initialize the controller instead of the mini-widgets
        const widgetsContainer = document.getElementById('batteryWidgetsContainer');
        if (widgetsContainer && this.availableMetrics) {
            // Load both variables and commands
            Promise.all([
                this.loadUPSVariables(),
                this.loadUPSCommands()
            ]).then(([variables, commands]) => {
                // Filter only the battery variables
                const batteryVariables = variables.filter(variable => {
                    const name = variable.name.toLowerCase();
                    return name.startsWith('battery.') || 
                           name.includes('batt.') ||
                           name.includes('runtime') ||
                           (name.includes('charge') && !name.includes('recharge'));
                });
                this.renderAllWidgets(widgetsContainer, batteryVariables);
            });
        }

        const healthElement = document.querySelector("#batteryHealthChart");
        if (healthElement) {
            this.initBatteryHealthChart(healthElement);
        }

        if (this.combinedChart) {
            this.combinedChart.updateOptions({
                chart: {
                    animations: {
                        enabled: true,
                        easing: 'linear',
                        dynamicAnimation: {
                            speed: 1000
                        }
                    }
                },
                // Keep only the last N points for performance
                series: [{
                    data: []
                }, {
                    data: []
                }, {
                    data: []
                }]
            });
        }

        // Temperature Chart
        const temperatureEl = document.querySelector("#temperatureChart");
        const temperatureCard = temperatureEl?.closest('.combined_card');
        
        if (temperatureEl && this.availableMetrics?.battery_temperature) {
            this.temperatureChart = new ApexCharts(temperatureEl, {
                series: [{
                    name: 'Battery Temperature',
                    data: []
                }],
                chart: {
                    type: 'line',
                    height: 350,
                    animations: { enabled: true }
                },
                stroke: {
                    curve: 'smooth',
                    width: 2
                },
                xaxis: { 
                    type: 'datetime',
                    labels: { datetimeUTC: false }
                },
                yaxis: {
                    title: { text: 'Temperature (°C)' },
                    decimalsInFloat: 1,
                    min: 15,  // Minimum 15°C
                    max: 30   // Maximum 30°C
                },
                tooltip: {
                    shared: true,
                    x: { format: 'dd MMM yyyy HH:mm:ss' }
                }
            });
            this.temperatureChart.render();
            if (temperatureCard) temperatureCard.style.display = 'block';
        } else {
            // Hide the chart container if there is no temperature data
            if (temperatureCard) temperatureCard.style.display = 'none';
            webLogger.data("Temperature data not available for this UPS");
        }
    }
    // CONTROLLER
    initCombinedChart(element) {
        const options = {
            series: [
                {
                    name: 'Battery Level',
                    data: [],
                    color: '#2E93fA',
                    type: 'line'
                },
                {
                    name: 'Runtime',
                    data: [],
                    color: '#66DA26',
                    type: 'line'
                },
                {
                    name: 'Voltage',
                    data: [],
                    color: '#FF9800',
                    type: 'line'
                }
            ],
            chart: {
                type: 'line',
                height: 450,
                animations: {
                    enabled: true,
                    easing: 'linear',
                    dynamicAnimation: {
                        speed: 1000
                    }
                },
                toolbar: {
                    show: true
                },
                noData: {
                    text: 'Loading data...',
                    align: 'center',
                    verticalAlign: 'middle',
                    style: {
                        fontSize: '16px'
                    }
                }
            },
            stroke: {
                curve: 'smooth',
                width: [2, 2, 2]
            },
            xaxis: {
                type: 'datetime',
                labels: {
                    datetimeUTC: false,
                    rotate: 0,
                    formatter: this.formatChartDate
                }
            },
            tooltip: {
                x: {
                    formatter: this.formatTooltipDate
                },
                y: {
                    formatter: function(value) {
                        // Format Y values with 2 decimals in tooltip
                        return parseFloat(value).toFixed(2);
                    }
                }
            },
            yaxis: [
                {
                    title: {
                        text: 'Battery Level (%)',
                        style: { color: '#2E93fA' }
                    },
                    min: 0,
                    max: 100,
                    tickAmount: 5,
                    decimalsInFloat: 0,
                    labels: {
                        formatter: function(val) {
                            return Math.round(val);
                        },
                        style: { colors: '#2E93fA' }
                    }
                },
                {
                    opposite: true,
                    title: {
                        text: 'Runtime (min)',
                        style: { color: '#66DA26' }
                    },
                    labels: {
                        formatter: function(val) {
                            return Math.round(val);
                        },
                        style: { colors: '#66DA26' }
                    }
                },
                {
                    opposite: true,
                    title: {
                        text: 'Voltage (V)',
                        style: { color: '#FF9800' }
                    },
                    min: 0,
                    tickAmount: 5,
                    labels: {
                        formatter: function(val) {
                            return Math.round(val);
                        },
                        style: { colors: '#FF9800' }
                    }
                }
            ],
            legend: {
                horizontalAlign: 'center'
            }
        };

        this.combinedChart = new ApexCharts(element, options);
        this.combinedChart.render();
    }

    initBatteryHealthChart(element) {
        // Take the health value from the data attribute
        const initialHealth = parseFloat(element.dataset.health) || 0;
        
        const options = {
            chart: {
                type: 'radialBar',
                height: 350
            },
            plotOptions: {
                radialBar: {
                    startAngle: -135,
                    endAngle: 135,
                    hollow: {
                        margin: 15,
                        size: '70%'
                    },
                    track: {
                        background: '#e7e7e7',
                        strokeWidth: '97%',
                        margin: 5
                    },
                    dataLabels: {
                        name: {
                            show: true,
                            fontSize: '16px',
                            color: '#888',
                            offsetY: -10
                        },
                        value: {
                            show: true,
                            fontSize: '30px',
                            offsetY: 5,
                            formatter: function (val) {
                                return parseFloat(val).toFixed(2) + '%';
                            }
                        }
                    }
                }
            },
            fill: {
                type: 'gradient',
                gradient: {
                    shade: 'dark',
                    type: 'horizontal',
                    shadeIntensity: 0.5,
                    gradientToColors: ['#ABE5A1'],
                    inverseColors: true,
                    opacityFrom: 1,
                    opacityTo: 1,
                    stops: [0, 100]
                }
            },
            stroke: {
                lineCap: 'round'
            },
            labels: ['Battery Health'],
            series: [initialHealth]
        };

        this.batteryHealthChart = new ApexCharts(element, options);
        this.batteryHealthChart.render();
    }

    async initEventListeners() {
        webLogger.page('Setting up event listeners');
        // Date range dropdown
        const dateRangeBtn = document.getElementById('dateRangeBtn');
        const dateRangeDropdown = document.getElementById('dateRangeDropdown');
        const timeRangeSelector = document.getElementById('timeRangeSelector');
        const fromTimeInput = document.getElementById('fromTime');
        const toTimeInput = document.getElementById('toTime');
        const applyTimeRange = document.getElementById('applyTimeRange');

        // Set the current time in the "To" field
        const now = new Date();
        if (toTimeInput) {
            toTimeInput.value = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: this._timezone });
        }

        // Toggle the dropdown
        if (dateRangeBtn && dateRangeDropdown) {
            dateRangeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dateRangeDropdown.classList.toggle('hidden');
            });
        }

        // Apply time range button
        if (applyTimeRange) {
            applyTimeRange.addEventListener('click', async () => {
                const fromTime = fromTimeInput.value;
                const toTime = toTimeInput.value;
                
                // Reset ONLY when clicking Apply
                this.resetAllData();
                
                const displayText = `Today (${fromTime} - ${toTime})`;
                this.updateDisplayedRange(displayText);
                
                await this.loadData('today', fromTime, toTime);
                dateRangeDropdown.classList.add('hidden');
            });
        }

        // Range options
        document.querySelectorAll('.range-options a').forEach(option => {
            option.addEventListener('click', async (e) => {
                e.preventDefault();
                const range = option.dataset.range;
                
                // Remove active from all options
                document.querySelectorAll('.range-options a').forEach(opt => {
                    opt.classList.remove('active');
                });
                option.classList.add('active');

                // Hide all panels
                document.querySelectorAll('.time-selector, .day-selector, .range-selector, .realtime-selector').forEach(panel => {
                    panel.classList.add('hidden');
                });

                switch(range) {
                    case 'realtime':
                        document.getElementById('realtimeSelector').classList.remove('hidden');
                        this.stopRealtimeUpdates(); // Stop previous updates
                        this.resetCharts(); // Reset charts
                        this.startRealTimeMode();
                        break;
                    case 'today':
                        const now = new Date();
                        const currentTime = now.toLocaleTimeString([], { 
                            hour: '2-digit', 
                            minute: '2-digit', 
                            timeZone: this._timezone 
                        });
                        this.stopRealtimeUpdates();
                        this.resetCharts();
                        this.updateDisplayedRange(`Today (00:00 - ${currentTime})`);
                        await this.loadData('today', '00:00', currentTime);
                        break;
                    case 'day':
                        this.stopRealtimeUpdates();
                        document.getElementById('daySelectorPanel').classList.remove('hidden');
                        break;
                    case 'range':
                        this.stopRealtimeUpdates();
                        document.getElementById('dateRangeSelectorPanel').classList.remove('hidden');
                        break;
                }
            });
        });

        // Single day selection
        const applyDay = document.getElementById('applyDay');
        if (applyDay) {
            applyDay.addEventListener('click', async () => {
                const selectedDate = document.getElementById('dayPicker').value;
                if (selectedDate) {
                    const displayText = new Date(selectedDate).toLocaleDateString([], { timeZone: this._timezone });
                    this.updateDisplayedRange(displayText);
                    await this.loadData('day', selectedDate);
                    dateRangeDropdown.classList.add('hidden');
                }
            });
        }

        // Correct the IDs for the date range
        const rangeSelectorPanel = document.getElementById('dateRangeSelectorPanel'); // was 'rangeSelectorPanel'
        if (rangeSelectorPanel) {
            const applyRange = rangeSelectorPanel.querySelector('#applyRange');
            const fromDate = rangeSelectorPanel.querySelector('#rangeFromDate');
            const toDate = rangeSelectorPanel.querySelector('#rangeToDate');
            
            if (applyRange) {
                applyRange.addEventListener('click', async () => {
                    if (fromDate.value && toDate.value) {
                        this.resetAllData();
                        const displayText = `${fromDate.value} to ${toDate.value}`;
                        this.updateDisplayedRange(displayText);
                        await this.loadData('range', fromDate.value, toDate.value);
                        document.getElementById('dateRangeDropdown').classList.add('hidden');
                    }
                });
            }
        }

        // Click outside to close the dropdown
        document.addEventListener('click', (e) => {
            if (!dateRangeBtn.contains(e.target) && !dateRangeDropdown.contains(e.target)) {
                dateRangeDropdown.classList.add('hidden');
            }
        });

        // Set the limits of the date picker based on the available data
        const dayPicker = document.getElementById('dayPicker');
        const rangeFromDate = document.getElementById('rangeFromDate');
        const rangeToDate = document.getElementById('rangeToDate');

        if (this.availableMetrics) {
            const firstDate = this.availableMetrics.first_date;
            const lastDate = this.availableMetrics.last_date;

            if (dayPicker) {
                dayPicker.min = firstDate;
                dayPicker.max = lastDate;
            }
            if (rangeFromDate) {
                rangeFromDate.min = firstDate;
                rangeFromDate.max = lastDate;
            }
            if (rangeToDate) {
                rangeToDate.min = firstDate;
                rangeToDate.max = lastDate;
            }
        }

        // Add listener for the real-time Apply button
        const realtimeSelector = document.getElementById('realtimeSelector');
        if (realtimeSelector) {
            const applyRealTime = realtimeSelector.querySelector('#applyRealTime');
            const intervalInput = realtimeSelector.querySelector('#realtimeInterval');
            
            if (applyRealTime) {
                applyRealTime.addEventListener('click', () => {
                    const newInterval = parseInt(intervalInput.value);
                    if (!isNaN(newInterval) && newInterval > 0) {
                        this.realTimeIntervalDuration = newInterval * 1000;
                        this.startRealTimeMode();
                        // Close the dropdown
                        document.getElementById('dateRangeDropdown').classList.add('hidden');
                    }
                });
            }
        }
    }

    calculateTimeRange(events) {
        try {
            // If there are no events, use the default range
            if (!events || events.length === 0) {
                const now = new Date();
                const start = new Date(now);
                start.setHours(0, 0, 0, 0);
                return {
                    start: start.toISOString(),
                    end: now.toISOString()
                };
            }

            // Otherwise, use the events range
            const timestamps = events.flatMap(event => [
                new Date(event.start_time).getTime(),
                new Date(event.end_time).getTime()
            ]);

            // Add validity checks
            const validTimestamps = timestamps.filter(ts => !isNaN(ts));
            
            if (validTimestamps.length === 0) {
                // If there are no valid timestamps, use the default range
                const now = new Date();
                const start = new Date(now);
                start.setHours(0, 0, 0, 0);
                return {
                    start: start.toISOString(),
                    end: now.toISOString()
                };
            }

            return {
                start: new Date(Math.min(...validTimestamps)).toISOString(),
                end: new Date(Math.max(...validTimestamps)).toISOString()
            };
        } catch (error) {
            webLogger.error('Error in calculateTimeRange:', error);
            // Return a default range in case of error
            const now = new Date();
            const start = new Date(now);
            start.setHours(0, 0, 0, 0);
            return {
                start: start.toISOString(),
                end: now.toISOString()
            };
        }
    }

    getDateFormat() {
        const selectedRange = document.querySelector('.range-options a.active');
        if (!selectedRange) return 'HH:mm';

        switch (selectedRange.dataset.range) {
            case 'realtime':
                return 'HH:mm:ss';
            case 'today':
                return 'HH:mm';
            case 'day':
                return 'HH:mm';
            case 'range':
                return 'dd MMM HH:mm';
            default:
                return 'HH:mm';
        }
    }

    async updateStats(stats) {
        webLogger.data('updateStats called with data:', stats);
        
        // Update the event counters
        if (stats.events && stats.events.available) {
            webLogger.data('Updating event counters:', stats.events);
            
            const totalEvents = document.querySelector('.event-value[data-type="total"]');
            const totalDuration = document.querySelector('.event-value[data-type="duration"]');
            const longestEvent = document.querySelector('.event-value[data-type="longest"]');
            
            webLogger.data('DOM elements found:', {
                totalEvents: !!totalEvents,
                totalDuration: !!totalDuration,
                longestEvent: !!longestEvent
            });
            
            if (totalEvents) {
                totalEvents.textContent = stats.events.count;
                webLogger.data('Total Events updated:', stats.events.count);
            }
            
            if (totalDuration) {
                const minutes = (stats.events.total_duration / 60).toFixed(1);
                totalDuration.textContent = `${minutes} min`;
                webLogger.data('Total Duration updated:', minutes);
            }
            
            if (longestEvent) {
                const minutes = (stats.events.longest_duration / 60).toFixed(1);
                longestEvent.textContent = `${minutes} min`;
                webLogger.data('Longest Event updated:', minutes);
            }
        }
        
        // Update the statistical values on the page
        document.querySelectorAll('.stat-value').forEach(element => {
            const type = element.dataset.type;
            if (!type || !isNaN(type)) return;  // Ignore elements without type or with numeric type
            
            webLogger.data(`Updating stat of type: ${type}`);
            
            try {
                let value;
                const statKey = type.startsWith('battery_') ? type : `battery_${type}`;
                
                if (stats[statKey]) {
                    const statData = stats[statKey];
                    if (typeof statData === 'object') {
                        value = parseFloat(statData.current ?? statData.value ?? statData.avg ?? 0);
                    } else {
                        value = parseFloat(statData);
                    }
                    
                    // Format the value based on the type
                    switch(type) {
                        case 'charge':
                        case 'battery_charge':
                            element.textContent = `${value.toFixed(1)}%`;
                            break;
                        case 'runtime':
                        case 'battery_runtime':
                            element.textContent = `${(value/60).toFixed(1)} min`;
                            break;
                        case 'voltage':
                        case 'battery_voltage':
                            element.textContent = `${value.toFixed(1)}V`;
                            break;
                        case 'temperature':
                        case 'battery_temperature':
                            element.textContent = `${value.toFixed(1)}°C`;
                            break;
                        default:
                            element.textContent = value.toFixed(1);
                    }
                } else {
                    webLogger.error(`No data found for ${statKey}`);
                }
            } catch (error) {
                webLogger.error(`Error updating stat ${type}`);
                element.textContent = '0.0';
            }
        });

        // NEW: Update battery health section (mini widgets and chart)
        this.updateBatteryHealthSection(stats);
    }

    // NEW method to update Battery Health UI (mini widgets and radial chart)
    updateBatteryHealthSection(stats) {
        // Retrieve aggregated stats if available
        const charge = stats.battery_charge && stats.battery_charge.avg != null ? parseFloat(stats.battery_charge.avg) : null;
        const voltage = stats.battery_voltage && stats.battery_voltage.avg != null ? parseFloat(stats.battery_voltage.avg) : null;
        // Use availableMetrics for nominal voltage (assumed not to change with time range)
        const voltageNominal = (this.availableMetrics && this.availableMetrics.battery_voltage_nominal) ? parseFloat(this.availableMetrics.battery_voltage_nominal) : null;
        const runtime = stats.battery_runtime && stats.battery_runtime.avg != null ? parseFloat(stats.battery_runtime.avg) : null;
        // Use availableMetrics for battery_runtime_low
        const runtimeLow = (this.availableMetrics && this.availableMetrics.battery_runtime_low) ? parseFloat(this.availableMetrics.battery_runtime_low) : null;

        // Update mini widget values if elements are present
        const chargeEl = document.getElementById('healthChargeValue');
        if (chargeEl && charge !== null) {
            chargeEl.textContent = charge.toFixed(1) + '%';
        }
        const runtimeEl = document.getElementById('healthRuntimeValue');
        if (runtimeEl && runtime !== null) {
            const runtimeMin = runtime / 60;
            runtimeEl.textContent = runtimeMin.toFixed(1) + ' min';
        }
        const voltageEl = document.getElementById('healthVoltageValue');
        if (voltageEl && voltage !== null && voltageNominal !== null) {
            voltageEl.textContent = voltage.toFixed(1) + 'V / ' + voltageNominal.toFixed(1) + 'V';
        }

        // Compute weighted battery health similar to backend logic
        const components = [];
        if (voltage !== null && voltageNominal !== null) {
            const voltageHealth = Math.min(100, (voltage / voltageNominal) * 100);
            components.push({ value: voltageHealth, weight: 0.4 });
        }
        if (runtime !== null && runtimeLow !== null && runtimeLow > 0) {
            const runtimeHealth = Math.min(100, (runtime / runtimeLow) * 50);
            components.push({ value: runtimeHealth, weight: 0.4 });
        }
        if (charge !== null) {
            const chargeHealth = charge;
            components.push({ value: chargeHealth, weight: 0.2 });
        }
        if (components.length === 0) return;
        
        const totalWeight = components.reduce((sum, comp) => sum + comp.weight, 0);
        const weightedSum = components.reduce((sum, comp) => sum + comp.value * comp.weight, 0);
        const finalHealth = weightedSum / totalWeight;

        // Update the Battery Health chart
        if (this.batteryHealthChart) {
            this.batteryHealthChart.updateSeries([finalHealth]);
        }
    }

    // Add this new helper method
    updateDisplayedRange(text) {
        // Update the text in the range button
        const dateRangeBtn = document.querySelector('.date-range-btn .selected-range');
        if (dateRangeBtn) {
            dateRangeBtn.textContent = text;
        }

        // Update all displayed periods
        document.querySelectorAll('.selected-period').forEach(span => {
            span.textContent = text;
        });
    }

    // New method to load UPS variables
    async loadUPSVariables() {
        try {
            const response = await fetch('/api/upsrw/list');
            const data = await response.json();
            return data.success ? data.variables : [];
        } catch (error) {
            webLogger.error('Error loading UPS variables:', error);
            return [];
        }
    }

    // New method to load UPS commands
    async loadUPSCommands() {
        try {
            const response = await fetch('/api/upscmd/list');
            const data = await response.json();
            return data.success ? data.commands : [];
        } catch (error) {
            webLogger.error('Error loading UPS commands:', error);
            return [];
        }
    }

    // New method to render all widgets
    renderAllWidgets(container, data) {
        if (!container || !data) {
            webLogger.warning('Missing container or data for battery widgets');
            return;
        }
        
        // Clean the container before adding widgets
        container.innerHTML = '';
        
        // Show the temperature widget only if the data is available
        if (data.battery_temperature) {
            const widgets = {
                'battery-temp': {
                    icon: 'temperature-half',
                    label: 'Temperature',
                    value: `${data.battery_temperature}°C`
                }
            };
    
            // Rendering the widgets
            Object.entries(widgets).forEach(([id, config]) => {
                try {
                    this.renderWidget(container, id, config);
                } catch (error) {
                    webLogger.error(`Error rendering widget ${id}:`, error);
                }
            });
        } else {
            webLogger.data('Temperature data not available for this UPS');
        }
    }

    // Add these new methods for real-time
    startRealTimeMode() {
        this.isRealTimeMode = true;
        
        // Stop any previous intervals
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }

        // Initialize charts with Chart.js for realtime
        this.initializeRealtimeBatteryChart();
        
        // Set the interval to update data
        this.realTimeInterval = setInterval(() => {
            if (this.isRealTimeMode) {
                fetch('/api/ups/cache')
                    .then(response => response.json())
                    .then(result => {
                        if (result.success && result.data && Array.isArray(result.data)) {
                            const data = result.data[1];  // Get the most recent data
                            this.updateWidgetValues(data);
                            this.updateStats(data);
                        }
                    })
                    .catch(error => webLogger.error('Error loading realtime data:', error));
            }
        }, this.realTimeIntervalDuration);

        // Update UI
        this.updateDisplayedRange('Real Time');
    }

    stopRealtimeUpdates() {
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }
        
        // Reset the mode
        this.isRealTimeMode = false;
        
        // Destroy the Chart.js charts if they exist
        if (this.combinedChart && this.combinedChart.destroy) {
            this.combinedChart.destroy();
            this.combinedChart = null;
        }
        
        if (this.temperatureChart && this.temperatureChart.destroy) {
            this.temperatureChart.destroy();
            this.temperatureChart = null;
        }
        
        // Clean the containers
        const combinedChartContainer = document.querySelector('#combinedBatteryChart');
        if (combinedChartContainer) combinedChartContainer.innerHTML = '';
        
        const temperatureChartContainer = document.querySelector('#temperatureChart');
        if (temperatureChartContainer) temperatureChartContainer.innerHTML = '';
        
        // Reinitialize the charts with ApexCharts
        this.initCharts();
    }

    initializeRealtimeBatteryChart() {
        // Get the container for the chart
        const container = document.querySelector('#combinedBatteryChart');
        if (!container) {
            console.error('Container #combinedBatteryChart not found');
            return;
        }
        
        // If an ApexCharts graph already exists, destroy it
        if (this.combinedChart && typeof this.combinedChart.destroy === 'function') {
            this.combinedChart.destroy();
        }
        
        // Remove the ApexCharts element and create a new canvas
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'realtimeBatteryChart';
        
        // Explicitly set the canvas height to match the ApexCharts height
        canvas.style.height = '450px'; // Same height defined in ApexCharts
        canvas.style.width = '100%';   // Width at 100% of container
        
        container.appendChild(canvas);
        
        const ctx = canvas.getContext('2d');
        
        // Determine which battery metrics are available
        const hasCharge = this.availableMetrics && this.availableMetrics.hasOwnProperty('battery_charge');
        const hasRuntime = this.availableMetrics && this.availableMetrics.hasOwnProperty('battery_runtime');
        const hasVoltage = this.availableMetrics && this.availableMetrics.hasOwnProperty('battery_voltage');
        
        // Initialize data buffers
        this.chargeDataBuffer = [];
        this.runtimeDataBuffer = [];
        this.voltageDataBuffer = [];
        this.bufferSize = 15; // For better smoothing
        
        // Create gradients for filling under the lines
        const chargeGradient = ctx.createLinearGradient(0, 0, 0, 300);
        chargeGradient.addColorStop(0, 'rgba(46, 147, 250, 0.3)');
        chargeGradient.addColorStop(1, 'rgba(46, 147, 250, 0.0)');
        
        const runtimeGradient = ctx.createLinearGradient(0, 0, 0, 300);
        runtimeGradient.addColorStop(0, 'rgba(102, 218, 38, 0.2)');
        runtimeGradient.addColorStop(1, 'rgba(102, 218, 38, 0.0)');
        
        const voltageGradient = ctx.createLinearGradient(0, 0, 0, 300);
        voltageGradient.addColorStop(0, 'rgba(255, 152, 0, 0.2)');
        voltageGradient.addColorStop(1, 'rgba(255, 152, 0, 0.0)');
        
        // Chart.js configuration
        const chartConfig = {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Battery Level',
                        backgroundColor: chargeGradient,
                        borderColor: '#2E93fA',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true,
                        cubicInterpolationMode: 'monotone',
                        yAxisID: 'y'
                    },
                    {
                        label: 'Runtime',
                        backgroundColor: runtimeGradient,
                        borderColor: '#66DA26',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true,
                        cubicInterpolationMode: 'monotone',
                        yAxisID: 'y1'
                    },
                    {
                        label: 'Voltage',
                        backgroundColor: voltageGradient,
                        borderColor: '#FF9800',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true,
                        cubicInterpolationMode: 'monotone',
                        yAxisID: 'y2'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    streaming: {
                        duration: 60000, // Show only 60 seconds
                        refresh: 1000,
                        delay: 1000,
                        onRefresh: this.onBatteryChartRefresh.bind(this)
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
                        min: 0,
                        max: 100,
                        position: 'left',
                        display: false,  // Completely hide Y axis
                        grid: {
                            display: false
                        }
                    },
                    y1: {
                        position: 'right',
                        display: false,  // Completely hide Y1 axis
                        grid: {
                            display: false
                        }
                    },
                    y2: {
                        position: 'right',
                        display: false,  // Completely hide Y2 axis
                        grid: {
                            display: false
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
                },
                layout: {
                    padding: {
                        left: 10,
                        right: 10,
                        top: 20,
                        bottom: 20
                    }
                }
            }
        };
        
        // Create the Chart.js chart
        this.combinedChart = new Chart(ctx, chartConfig);
        
        // Also initialize a new chart for temperature if available
        if (this.availableMetrics && this.availableMetrics.battery_temperature) {
            this.initializeRealtimeTemperatureChart();
        }
        
        webLogger.console('Realtime Chart.js initialized for battery analysis');
    }

    initializeRealtimeTemperatureChart() {
        const container = document.querySelector('#temperatureChart');
        if (!container) {
            console.error('Container #temperatureChart not found');
            return;
        }
        
        // If an ApexCharts graph already exists, destroy it
        if (this.temperatureChart && typeof this.temperatureChart.destroy === 'function') {
            this.temperatureChart.destroy();
        }
        
        // Remove the ApexCharts element and create a new canvas
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'realtimeTemperatureChart';
        
        // Explicitly set the canvas height to match the ApexCharts height
        canvas.style.height = '350px'; // Same height defined in ApexCharts for the temperature chart
        canvas.style.width = '100%';   // Width at 100% of container
        
        container.appendChild(canvas);
        
        const ctx = canvas.getContext('2d');
        
        // Create a gradient for filling under the line
        const tempGradient = ctx.createLinearGradient(0, 0, 0, 300);
        tempGradient.addColorStop(0, 'rgba(255, 99, 132, 0.3)');
        tempGradient.addColorStop(1, 'rgba(255, 99, 132, 0.0)');
        
        // Initialize the data buffer
        this.temperatureDataBuffer = [];
        
        // Chart.js configuration
        const chartConfig = {
                type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Temperature',
                        backgroundColor: tempGradient,
                        borderColor: '#FF6384',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true,
                        cubicInterpolationMode: 'monotone'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    streaming: {
                        duration: 60000, // Show only 60 seconds
                        refresh: 1000,
                        delay: 1000,
                        onRefresh: this.onTemperatureChartRefresh.bind(this)
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
                        min: 15,
                        max: 40,
                        display: false,  // Completely hide Y axis
                        grid: {
                            display: false
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
        };
        
        // Create the Chart.js chart
        this.temperatureChart = new Chart(ctx, chartConfig);
        
        webLogger.console('Realtime Chart.js initialized for temperature');
    }

    onBatteryChartRefresh(chart) {
        return fetch('/api/ups/cache')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data && Array.isArray(result.data)) {
                    const data = result.data[1];
                    const now = Date.now();
                    
                    // Extract battery values
                    const charge = parseFloat(data.battery_charge || 0);
                    const runtime = parseFloat(data.battery_runtime || 0) / 60; // Convert to minutes
                    const voltage = parseFloat(data.battery_voltage || 0);
                    
                    // Add new points to buffers
                    this.chargeDataBuffer.push({
                        time: now,
                        value: charge
                    });
                    
                    this.runtimeDataBuffer.push({
                        time: now,
                        value: runtime
                    });
                    
                    this.voltageDataBuffer.push({
                        time: now,
                        value: voltage
                    });
                    
                    // Keep buffers at the correct size
                    if (this.chargeDataBuffer.length > this.bufferSize) {
                        this.chargeDataBuffer.shift();
                    }
                    
                    if (this.runtimeDataBuffer.length > this.bufferSize) {
                        this.runtimeDataBuffer.shift();
                    }
                    
                    if (this.voltageDataBuffer.length > this.bufferSize) {
                        this.voltageDataBuffer.shift();
                    }
                    
                    // Calculate smoothed values
                    const smoothedCharge = this.calculateSmoothedValueSimple(this.chargeDataBuffer);
                    const smoothedRuntime = this.calculateSmoothedValueSimple(this.runtimeDataBuffer);
                    const smoothedVoltage = this.calculateSmoothedValueSimple(this.voltageDataBuffer);
                    
                    // Update datasets
                    chart.data.datasets[0].data.push({
                        x: now,
                        y: smoothedCharge
                    });
                    
                    chart.data.datasets[1].data.push({
                        x: now,
                        y: smoothedRuntime
                    });
                    
                    chart.data.datasets[2].data.push({
                        x: now,
                        y: smoothedVoltage
                    });
                    
                    chart.update('quiet');
                }
            })
            .catch(error => console.error('Error fetching battery data for chart:', error));
    }

    onTemperatureChartRefresh(chart) {
        return fetch('/api/ups/cache')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data && Array.isArray(result.data)) {
                    const data = result.data[1];
                    
                    // If there is no temperature data, exit
                    if (!data.battery_temperature) return;
                    
                    const now = Date.now();
                    const temperature = parseFloat(data.battery_temperature || 0);
                    
                    // Add the new point to the buffer
                    this.temperatureDataBuffer.push({
                        time: now,
                        value: temperature
                    });
                    
                    // Keep the buffer at the correct size
                    if (this.temperatureDataBuffer.length > this.bufferSize) {
                        this.temperatureDataBuffer.shift();
                    }
                    
                    // Calculate the smoothed value
                    const smoothedTemp = this.calculateSmoothedValueSimple(this.temperatureDataBuffer);
                    
                    // Add the smoothed value to the dataset
                    chart.data.datasets[0].data.push({
                        x: now,
                        y: smoothedTemp
                    });
                    
                    chart.update('quiet');
                }
            })
            .catch(error => console.error('Error fetching temperature data for chart:', error));
    }

    // Method to calculate the smoothed value
    calculateSmoothedValueSimple(buffer) {
        if (buffer.length === 0) return 0;
        
        // Use a smoothing algorithm with weights
        const weights = [];
        for (let i = 0; i < buffer.length; i++) {
            // Formula for giving more weight to recent values
            weights.push(Math.pow(1.2, i));
        }
        
        const weightSum = weights.reduce((a, b) => a + b, 0);
        
        // Calculate the weighted average
        let smoothedValue = 0;
        for (let i = 0; i < buffer.length; i++) {
            smoothedValue += buffer[i].value * weights[i];
        }
        
        return smoothedValue / weightSum;
    }

    // Method to update widget values from cache in real time
    updateWidgetValues(data) {
        document.querySelectorAll('.stat-value').forEach(element => {
            const type = element.dataset.type;
            if (!type || !data[type]) return;

            let value = data[type];
            let displayValue;

            // Format the value based on the type
            switch(type) {
                case 'battery_charge':
                case 'charge':
                    displayValue = parseFloat(value).toFixed(1) + '%';
                    break;
                case 'battery_runtime':
                case 'runtime':
                    displayValue = (parseFloat(value) / 60).toFixed(1) + ' min';
                    break;
                case 'battery_voltage':
                case 'voltage':
                    displayValue = parseFloat(value).toFixed(1) + 'V';
                    break;
                case 'battery_temperature':
                case 'temperature':
                    displayValue = parseFloat(value).toFixed(1) + '°C';
                    break;
                default:
                    displayValue = value.toString();
            }

            element.textContent = displayValue;
        });

        // Update also the info-value values
        document.querySelectorAll('.info-value').forEach(element => {
            const type = element.dataset.type;
            if (!type || !data[type]) return;
            
            let value = data[type];
            
            if (type === 'status') {
                element.textContent = this.formatUPSStatus(value);
            } else if (type === 'type') {
                element.textContent = this.formatBatteryType(value);
            } else if (type === 'temperature') {
                element.textContent = parseFloat(value).toFixed(1) + '°C';
            } else if (type === 'health') {
                element.textContent = parseFloat(value).toFixed(0) + '%';
            }
        });
    }

    // Add this new helper method
    updateEventsList(eventsList) {
        const eventsContainer = document.getElementById('batteryEventsChart');
        if (!eventsContainer) return;

        // Clear the container content
        eventsContainer.innerHTML = '';

        if (!eventsList || !eventsList.length) {
            eventsContainer.innerHTML = '<p>No events available</p>';
            return;
        }

        // Create a list element to display events similar to events_page.js
        const ul = document.createElement('ul');
        ul.className = 'events-list';

        eventsList.forEach(event => {
            // DEBUG: print the event object to check the content
            webLogger.console("DEBUG: Received event:", event);

            // Use the start_time field for the start date
            const startTimeStr = event.start_time;
            let formattedStart = "Invalid Date";
            if (startTimeStr) {
                const dtStart = new Date(startTimeStr);
                if (!isNaN(dtStart.getTime())) {
                    formattedStart = dtStart.toLocaleString([], {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: this._timezone
                    });
                }
            }
            webLogger.console("DEBUG: Formatted start =", formattedStart);

            // If available, format also end_time
            let formattedEnd = "";
            if (event.end_time) {
                const dtEnd = new Date(event.end_time);
                if (!isNaN(dtEnd.getTime())) {
                    formattedEnd = dtEnd.toLocaleString([], {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: this._timezone
                    });
                }
            }
            webLogger.console("DEBUG: Formatted end =", formattedEnd);

            // Map the 'type' field to a readable description
            let description = "";
            switch (event.type) {
                case "ONBATT":
                    description = formattedEnd ? "⚡ Switch to battery" : "⚡ On battery";
                    break;
                case "ONLINE":
                    description = "🔌 Back to Network";
                    break;
                case "LOWBATT":
                    description = "🪫 Battery Discharge";
                    break;
                default:
                    description = event.type || "Event";
            }
            webLogger.console("DEBUG: Description =", description);

            // Build the time display: if end_time exists show "start - end", otherwise only start
            const timeDisplay = formattedEnd ? `${formattedStart} - ${formattedEnd}` : formattedStart;

            const li = document.createElement('li');
            li.className = 'event-item';
            li.innerHTML = `<strong>${timeDisplay}</strong> - ${description}`;
            ul.appendChild(li);
        });

        eventsContainer.appendChild(ul);
        webLogger.console("DEBUG: Events list updated");
    }

    // New method to reset all data
    resetAllData() {
        // Reset the charts
        this.resetCharts();
        
        // Reset the widgets
        const widgetsContainer = document.getElementById('batteryWidgetsContainer');
        if (widgetsContainer) {
            widgetsContainer.innerHTML = '';
        }
        
        // Reset the statistics
        const statValues = document.querySelectorAll('.stat-value');
        statValues.forEach(stat => {
            stat.textContent = '0';
        });
        
        // Reset the health section
        if (this.batteryHealthChart) {
            this.batteryHealthChart.updateSeries([0]);
        }
    }

    renderWidget(container, id, config) {
        const widgetHtml = `
            <div class="stat_card" id="${id}">
                <div class="stat-icon">
                    <i class="fas fa-${config.icon}"></i>
                </div>
                <div class="stat-content">
                    <div class="stat-header">
                        <div class="stat-title-row">
                            <span class="stat-label">${config.label}</span>
                        </div>
                    </div>
                    <span class="stat-value">${config.value}</span>
                    ${config.warning ? `
                        <span class="stat-warning">
                            <i class="fas fa-triangle-exclamation"></i>
                            Warning: ${config.warning}
                        </span>
                    ` : ''}
                </div>
            </div>
        `;

        // Add the widget to the container
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = widgetHtml.trim();
        const widgetElement = tempDiv.firstChild;
        container.appendChild(widgetElement);
    }

    formatChartDate(timestamp) {
        return new Date(timestamp).toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: this._timezone
        });
    }

    formatTooltipDate(val) {
        return new Date(val).toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: this._timezone
        });
    }

    async checkHistoricalData() {
        try {
            // Check data for the last 24 hours
            const response = await fetch('/api/battery/history?period=day');
            const data = await response.json();
            
            if (!data.success || !data.data) return false;
            
            // Check if we have at least 5 minutes of data (2 points with 15 minutes sampling)
            const minRequiredPoints = 2;
            
            // Check if the main data has enough points
            const requiredMetrics = ['battery_charge', 'battery_runtime'];
            const hasEnoughData = requiredMetrics.every(metric => {
                const metricData = data.data[metric];
                return Array.isArray(metricData) && metricData.length >= minRequiredPoints;
            });

            webLogger.data(`Historical data check - Has enough data: ${hasEnoughData}`);
            webLogger.data(`Points available - Charge: ${data.data.battery_charge?.length || 0}, Runtime: ${data.data.battery_runtime?.length || 0}`);
            
            return hasEnoughData;
        } catch (error) {
            webLogger.error('Error checking historical data:', error);
            return false;
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <i class="fas fa-info-circle"></i>
            <span>${message}</span>
        `;
        
        document.body.appendChild(notification);
        
        // Remove after 5 seconds
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    renderBatteryWidgets(container) {
        const batteryVariables = [];
    
        for (const [key, value] of Object.entries(this.availableMetrics)) {
            // Skip the temperature widget if there is no data
            if (key === 'battery_temperature' && !value) continue;
            
            let unit = '';
            if (key.includes('voltage')) {
                unit = 'V';
            } else if (key.includes('charge')) {
                unit = '%';
            } else if (key.includes('runtime')) {
                unit = 'min';
            } else if (key.includes('temperature')) {
                unit = '°C';
            }

            let icon = 'fa-battery-half';
            if (key.includes('voltage')) icon = 'fa-bolt';
            if (key.includes('runtime')) icon = 'fa-clock';
            if (key.includes('temperature')) icon = 'fa-thermometer-half';

            // Create widget configuration
            const widgetConfig = {
                id: `battery-${key}`,
                icon: icon,
                label: this.formatMetricName(key),
                value: `${value}${unit}`,
                warning: this.getMetricWarning(key, value)
            };

            // Add to battery variables array
            batteryVariables.push(widgetConfig);

            // Render the widget
            this.renderWidget(container, widgetConfig.id, widgetConfig);
        }

        return batteryVariables;
    }

    // Helper method to format metric names
    formatMetricName(key) {
        return key
            .replace('battery_', '')
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    // Helper method to get metric warnings
    getMetricWarning(key, value) {
        const warnings = {
            battery_charge: (val) => val < 20 ? 'Low battery level' : null,
            battery_voltage: (val) => val < 11 ? 'Critical voltage' : null,
            battery_temperature: (val) => val > 40 ? 'High temperature' : null,
            battery_runtime: (val) => val < 300 ? 'Low runtime' : null
        };

        return warnings[key] ? warnings[key](value) : null;
    }

    updateChartsRealTime(data) {
        if (!data) return;
        
        const timestamp = new Date().getTime();
        
        if (this.combinedChart) {
            const newData = [
                {
                    name: 'Battery Level',
                    data: data.battery_charge ? [[timestamp, parseFloat(data.battery_charge)]] : []
                },
                {
                    name: 'Runtime',
                    data: data.battery_runtime ? [[timestamp, parseFloat(data.battery_runtime) / 60]] : []
                },
                {
                    name: 'Voltage',
                    data: data.battery_voltage ? [[timestamp, parseFloat(data.battery_voltage)]] : []
                }
            ];
            
            try {
                this.combinedChart.appendData(newData);
            } catch (error) {
                webLogger.error('Error updating charts:', error);
                // In case of error, try to reset and reinitialize
                this.resetCharts();
                this.initCharts();
            }
        }
        
        if (this.temperatureChart && data.battery_temperature !== undefined) {
            try {
                this.temperatureChart.appendData([{
                    name: 'Battery Temperature',
                    data: [[timestamp, parseFloat(data.battery_temperature)]]
                }]);
            } catch (error) {
                webLogger.error('Error updating temperature chart:', error);
            }
        }
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

    formatBatteryType(type) {
        if (!type) return 'Unknown';
        
        const types = {
            'PbAc': 'Lead Acid',
            'Li': 'Lithium Ion',
            'LiP': 'Lithium Polymer',
            'NiCd': 'Nickel Cadmium',
            'NiMH': 'Nickel Metal Hydride',
            'SLA': 'Sealed Lead Acid',
            'VRLA': 'Valve Regulated Lead Acid',
            'AGM': 'Absorbed Glass Mat',
            'Gel': 'Gel Cell',
            'Flooded': 'Flooded Lead Acid'
        };
        
        return types[type] || type;
    }

    resetCharts() {
        // Reset the combined chart
        if (this.combinedChart) {
            this.combinedChart.updateSeries([{
                name: 'Battery Charge',
                data: []
            }, {
                name: 'Runtime',
                data: []
            }, {
                name: 'Voltage',
                data: []
            }]);
        }
        
        // Reset the temperature chart
        if (this.temperatureChart) {
            this.temperatureChart.updateSeries([{
                name: 'Temperature',
                data: []
            }]);
        }
        
        // Reset the battery events chart
        if (this.batteryEventsChart) {
            this.batteryEventsChart.updateSeries([{
                name: 'Events',
                data: []
            }]);
        }
        
        // Reset the battery health chart
        if (this.batteryHealthChart) {
            this.batteryHealthChart.updateSeries([{
                name: 'Health',
                data: [0]
            }]);
        }
    }
}

// Add the voltage controller
class BatteryVoltageController {
    constructor(chart) {
        this.hasVoltage = false;
        this.hasNominalVoltage = false;
        this.voltage = 0;
        this.nominalVoltage = 0;
        this.widget = document.querySelector('[data-type="voltage"]')?.closest('.stat_card');
        this.chart = chart;
    }

    init(data) {
        this.checkAvailability(data);
        this.updateWidget();
        this.updateChart();
    }

    update(data) {
        this.checkAvailability(data);
        this.updateWidget();
        this.updateChart();
    }

    checkAvailability(data) {
        // Check if the values are available
        this.hasVoltage = data.hasOwnProperty('battery_voltage') && data.battery_voltage !== null;
        this.hasNominalVoltage = data.hasOwnProperty('battery_voltage_nominal') && data.battery_voltage_nominal !== null;
        
        // Update the values if available
        if (this.hasVoltage) {
            this.voltage = parseFloat(data.battery_voltage);
        }
        if (this.hasNominalVoltage) {
            this.nominalVoltage = parseFloat(data.battery_voltage_nominal);
        }
    }

    updateWidget() {
        if (!this.widget) return;

        if (this.hasVoltage) {
            this.widget.style.display = 'flex';
            const valueEl = this.widget.querySelector('.stat-value');
            if (valueEl) {
                valueEl.textContent = `${this.voltage.toFixed(1)}V`;
            }

            const trendEl = this.widget.querySelector('.stat-trend');
            if (trendEl && this.hasNominalVoltage) {
                trendEl.innerHTML = `
                    <i class="fas fa-info-circle"></i>
                    Nominal: ${this.nominalVoltage.toFixed(1)}V
                `;
            }
        } else {
            this.widget.style.display = 'none';
        }
    }

    updateChart() {
        if (!this.chart) return;

        const timestamp = new Date().getTime();
        const voltageData = this.hasVoltage ? [{
            x: timestamp,
            y: this.voltage
        }] : [];

        // Update only the voltage series while keeping the others
        const currentSeries = this.chart.w.config.series;
        this.chart.updateSeries([
            currentSeries[0], // battery level
            currentSeries[1], // runtime
            { 
                name: 'Voltage',
                data: voltageData,
                type: 'line',
                color: '#FF9800'
            }
        ], true);
    }
}

class BatteryMetricsController {
    constructor(chart) {
        this.chart = chart;
        this.metrics = {
            battery_charge: {
                available: false,
                value: 0,
                widget: document.querySelector('[data-type="charge"]')?.closest('.stat_card'),
                color: '#2E93fA',
                unit: '%',
                label: 'Charge'
            },
            battery_runtime: {
                available: false,
                value: 0,
                widget: document.querySelector('[data-type="runtime"]')?.closest('.stat_card'),
                color: '#66DA26',
                unit: 'min',
                label: 'Runtime',
                transform: value => value / 60 // Convert to minutes
            },
            battery_temperature: {
                available: false,
                value: 0,
                widget: document.querySelector('[data-type="temperature"]')?.closest('.stat_card'),
                color: '#FF5252',
                unit: '°C',
                label: 'Temperature'
            }
        };
    }

    init(data) {
        this.checkAvailability(data);
        this.updateWidgets();
        this.updateChart();
    }

    update(data) {
        this.checkAvailability(data);
        this.updateWidgets();
        this.updateChart();
    }

    checkAvailability(data) {
        Object.keys(this.metrics).forEach(metric => {
            const available = data.hasOwnProperty(metric) && data[metric] !== null;
            this.metrics[metric].available = available;
            if (available) {
                let value = parseFloat(data[metric]);
                if (this.metrics[metric].transform) {
                    value = this.metrics[metric].transform(value);
                }
                this.metrics[metric].value = value;
            }
        });
    }

    updateWidgets() {
        Object.entries(this.metrics).forEach(([key, metric]) => {
            if (!metric.widget) return;

            if (metric.available) {
                metric.widget.style.display = 'flex';
                const valueEl = metric.widget.querySelector('.stat-value');
                if (valueEl) {
                    valueEl.textContent = `${metric.value.toFixed(1)}${metric.unit}`;
                }
            } else {
                metric.widget.style.display = 'none';
            }
        });
    }

    updateChart() {
        if (!this.chart) return;

        const timestamp = new Date().getTime();
        const series = Object.entries(this.metrics)
            .filter(([_, metric]) => metric.available)
            .map(([key, metric]) => ({
                name: metric.label,
                data: [{
                    x: timestamp,
                    y: metric.value
                }],
                type: 'line',
                color: metric.color
            }));

        this.chart.updateSeries(series, true);
    }
}

// Initialize the page when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    new BatteryPage();
}); 