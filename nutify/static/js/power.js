class PowerPage extends BasePage {
    constructor() {
        super();
        webLogger.enable(false);
        this.availableMetrics = null;
        this.isRealTimeMode = false;
        this.realTimeInterval = null;
        this.realTimeIntervalDuration = 1000;
        this.isFirstRealTimeUpdate = true;
        
        this._timezone = this.getConfiguredTimezone();
        
        // CALL METHODS TO INITIALIZE UI
        this.initEventListeners();
        
        (async () => {
            try {
                await this.loadMetrics();
                this.initCharts();
                
                // Check if there is data in the database
                const now = new Date();
                const currentTime = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? 
                    window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });

                // Verify if we have historical data
                const hasHistoricalData = await this.checkHistoricalData();
                
                if (hasHistoricalData) {
                    // If we have data, use Today mode
                    this.isRealTimeMode = false;
                    
                    // Load the today data by default
                    const fromTimeInput = document.getElementById('fromTime');
                    const toTimeInput = document.getElementById('toTime');
                    if (fromTimeInput) fromTimeInput.value = '00:00';
                    if (toTimeInput) toTimeInput.value = currentTime;

                    // Activate the today option in the menu
                    document.querySelectorAll('.range-options a').forEach(option => {
                        option.classList.remove('active');
                        if (option.dataset.range === 'today') {
                            option.classList.add('active');
                        }
                    });

                    this.updateDisplayedRange(`Today (00:00 - ${currentTime})`);
                    
                    // Load the today data
                    await this.loadData('day', '00:00', currentTime);
                } else {
                    // If no historical data, switch to realtime mode
                    this.isRealTimeMode = true;
                    
                    // Activate the realtime option in the menu
                    document.querySelectorAll('.range-options a').forEach(option => {
                        option.classList.remove('active');
                        if (option.dataset.range === 'realtime') {
                            option.classList.add('active');
                        }
                    });
                    
                    this.updateDisplayedRange('Real Time');
                    
                    // Start realtime updates
                    this.startRealTimeUpdates();
                }
                
            } catch (error) {
                webLogger.error('Error in PowerPage initialization:', error);
                this.showError('Error initializing power page');
                
                // On error, default to realtime mode as a fallback
                this.isRealTimeMode = true;
                this.startRealTimeUpdates();
            }
        })();
    }

    /**
     * loadData:
     * Fetches power statistics and history data from the API based on the time range.
     */
    async loadData(period = 'day', fromTime = null, toTime = null) {
        try {
            this.showLoadingState();
            
            const params = new URLSearchParams();
            params.append('period', period);
            
            const selectedRange = document.querySelector('.range-options a.active');
            const rangeType = selectedRange ? selectedRange.dataset.range : 'day';
            
            webLogger.data('LoadData params:', {
                period,
                rangeType,
                fromTime,
                toTime
            });

            if (rangeType === 'realtime' || this.isRealTimeMode) {
                webLogger.data('Switching to realtime mode');
                this.startRealTimeUpdates();
                this.hideLoadingState();
                return;
            }

            // F Select Day
            if (rangeType === 'day') {
                // Format the date properly (only YYYY-MM-DD)
                const formattedDate = fromTime.includes('T') ? fromTime.split('T')[0] : fromTime;
                
                // Set parameters - use only the date without time
                params.set('period', 'range');
                params.set('from_time', formattedDate);
                params.set('to_time', formattedDate);
                
                webLogger.data('API parameters for Select Day:', {
                    formattedDate,
                    params: Object.fromEntries(params.entries())
                });
            }
            // For Date Range
            else if (rangeType === 'range') {
                params.append('from_time', fromTime);
                params.append('to_time', toTime);
                webLogger.data('Date Range Mode:', { from: fromTime, to: toTime });
            }
            // Per Today
            else if (rangeType === 'today') {
                params.append('from_time', fromTime);
                params.append('to_time', toTime);
                webLogger.data('Today Mode:', { from: fromTime, to: toTime });
            }

            // Add debug logging before API calls
            const apiUrl = `/api/power/history?${params.toString()}`;
            webLogger.data('Final API URL:', {
                url: apiUrl,
                params: Object.fromEntries(params.entries())
            });

            const [statsResponse, historyResponse] = await Promise.all([
                fetch(`/api/power/stats?${params.toString()}`),
                fetch(apiUrl)
            ]);

            const stats = await statsResponse.json();
            const history = await historyResponse.json();

            webLogger.data('Raw API Responses:', {
                statsStatus: statsResponse.status,
                historyStatus: historyResponse.status,
                statsData: stats,
                historyData: history
            });

            if (stats.success && history.success) {
                // Important: First update the statistics
                await this.updateStats(stats.data);
                
                // Then ensure animations are enabled before updating the chart
                if (this.combinedChart) {
                    await this.combinedChart.updateOptions({
                        chart: {
                            animations: {
                                enabled: true,
                                easing: 'linear',
                                dynamicAnimation: {
                                    speed: 1000
                                }
                            }
                        }
                    }, false, false);
                }
                
                // Finally update the charts with animation
                await this.updateCharts(history.data);
            }

            this.hideLoadingState();
        } catch (error) {
            webLogger.error('Error in loadData:', error);
            this.showError('Error loading data');
            this.hideLoadingState();
        }
    }

    /**
     * loadMetrics:
     * Retrieves available power metrics from the API.
     */
    async loadMetrics() {
        try {
            const response = await fetch('/api/power/metrics');
            const data = await response.json();
            if (data.success && data.data) {
                this.availableMetrics = data.data;
                webLogger.data('Available power metrics', this.availableMetrics);
            }
        } catch (error) {
            webLogger.error('Error loading power metrics', error);
        }
    }

    /**
     * initCharts:
     * Initializes the combined chart for power metrics.
     */
    initCharts() {
        webLogger.page('Initializing power charts');

        // Always initialize with ApexCharts by default
        const combinedChartElement = document.querySelector("#combinedPowerChart");
        if (combinedChartElement && (
            this.availableMetrics?.ups_power ||
            this.availableMetrics?.ups_realpower ||
            this.availableMetrics?.input_voltage
        )) {
            // Initialize ApexCharts - this is our default
            this.initCombinedChart(combinedChartElement);
            
            // Important: Initialize with empty series first to enable animation on first data load
            if (this.combinedChart) {
                this.combinedChart.updateOptions({
                    chart: {
                        animations: {
                            enabled: true,
                            easing: 'linear',
                            dynamicAnimation: {
                                speed: 1000
                            }
                        },
                    },
                    series: [{
                        name: 'Real Power',
                        data: []
                    }, {
                        name: 'Input Voltage',
                        data: []
                    }]
                });
            }
        }
    }

    /**
     * initCombinedChart:
     * Initializes the ApexCharts combined chart with predefined options.
     * @param {HTMLElement} element - The DOM element in which to render the chart.
     */
    initCombinedChart(element) {
        const options = {
            series: [
                {
                    name: 'Real Power',
                    data: [],
                    color: '#66DA26',
                    type: 'line'
                },
                {
                    name: 'Input Voltage',
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
                }
            },
            stroke: {
                curve: 'smooth',
                width: [2, 2]
            },
            xaxis: {
                type: 'datetime',
                labels: {
                    datetimeUTC: false,
                    formatter: function(value, timestamp, opts) {
                        return new Date(timestamp).toLocaleString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        });
                    }
                }
            },
            tooltip: {
                x: {
                    formatter: function(val, { series, seriesIndex, dataPointIndex, w }) {
                        return new Date(val).toLocaleString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                        });
                    }
                },
                y: {
                    formatter: function(value) {
                        return parseFloat(value).toFixed(2);
                    }
                }
            },
            yaxis: [
                {
                    title: {
                        text: 'Real Power (W)',
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
                        text: 'Input Voltage (V)',
                        style: { color: '#FF9800' }
                    },
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

    /**
     * updateCharts:
     * Updates the combined chart with historical power data.
     * Uses fallback empty arrays if certain metrics are missing.
     * @param {object} data - The historical data for power metrics.
     */
    async updateCharts(data) {
        if (!data || !this.combinedChart) {
            webLogger.error('No data or chart not initialized');
            return;
        }

        webLogger.data('Updating charts with data:', data);
        
        const { ups_power, ups_realpower, input_voltage } = data;
        
        // Log received data details
        webLogger.data('Data points received:', {
            ups_power: ups_power?.length || 0,
            ups_realpower: ups_realpower?.length || 0,
            input_voltage: input_voltage?.length || 0
        });

        // Map data for each metric; if data array is empty, use an empty array
        const upsRealPowerData = ups_realpower && ups_realpower.length > 0 ? ups_realpower.map(point => {
            const timestamp = new Date(point.timestamp).getTime();
            const value = parseFloat(point.value);
            if (isNaN(value)) {
                webLogger.warning(`Invalid real power value at ${point.timestamp}: ${point.value}`);
                return null;
            }
            return { x: timestamp, y: value };
        }).filter(point => point !== null) : [];

        const inputVoltageData = input_voltage && input_voltage.length > 0 ? input_voltage.map(point => {
            const timestamp = new Date(point.timestamp).getTime();
            const value = parseFloat(point.value);
            if (isNaN(value)) {
                webLogger.warning(`Invalid voltage value at ${point.timestamp}: ${point.value}`);
                return null;
            }
            return { x: timestamp, y: value };
        }).filter(point => point !== null) : [];

        webLogger.data('Processed data points:', {
            realPower: upsRealPowerData.length,
            inputVoltage: inputVoltageData.length
        });

        const series = [
            {
                name: 'Real Power',
                data: upsRealPowerData
            },
            {
                name: 'Input Voltage',
                data: inputVoltageData
            }
        ];

        // Determine xaxis options based on selected time range
        const selectedRange = document.querySelector('.range-options a.active');
        const rangeType = selectedRange ? selectedRange.dataset.range : 'day';
        
        webLogger.data('Chart range type:', rangeType);
        
        let xaxisOptions = { 
            type: 'datetime', 
            labels: { 
                datetimeUTC: false,
                formatter: function(value, timestamp) {
                    const date = new Date(timestamp);
                    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
            }
        };

        if (rangeType === 'realtime') {
            const now = new Date();
            xaxisOptions.min = now.getTime() - (30 * 1000);
            xaxisOptions.max = now.getTime();
        } else if (rangeType === 'range') {
            const fromDateInput = document.getElementById('rangeFromDate');
            const toDateInput = document.getElementById('rangeToDate');
            if (fromDateInput && toDateInput && fromDateInput.value && toDateInput.value) {
                // Find actual data range for range mode only
                if (upsRealPowerData.length > 0) {
                    const actualDataMin = Math.min(...upsRealPowerData.map(p => p.x));
                    const actualDataMax = Math.max(...upsRealPowerData.map(p => p.x));
                    xaxisOptions = {
                        type: 'datetime',
                        min: actualDataMin,
                        max: actualDataMax,
                        labels: {
                            datetimeUTC: false,
                            formatter: function(value) {
                                const date = new Date(value);
                                return date.toLocaleDateString([], { 
                                    day: 'numeric',
                                    month: 'short'
                                });
                            }
                        }
                    };
                }
            }
        } else if (rangeType === 'day') {
            const dayPicker = document.getElementById('dayPicker');
            if (dayPicker && dayPicker.value) {
                const selectedDate = new Date(dayPicker.value);
                selectedDate.setHours(0, 0, 0, 0);
                const endDate = new Date(dayPicker.value);
                endDate.setHours(23, 59, 59, 999);

                xaxisOptions = {
                    type: 'datetime',
                    min: selectedDate.getTime(),
                    max: endDate.getTime(),
                    tickAmount: 24,
                    labels: {
                        datetimeUTC: false,
                        formatter: function(value) {
                            return new Date(value).toLocaleTimeString([], { 
                                hour: '2-digit', 
                                minute: '2-digit'
                            });
                        }
                    },
                    tickPlacement: 'on',
                    axisBorder: {
                        show: true
                    },
                    axisTicks: {
                        show: true
                    }
                };
            }
        } else if (rangeType === 'today') {
            const fromTimeInput = document.getElementById('fromTime');
            const toTimeInput = document.getElementById('toTime');
            if (fromTimeInput && toTimeInput) {
                const today = new Date();
                const fromTime = new Date(today.toDateString() + ' ' + fromTimeInput.value);
                const toTime = new Date(today.toDateString() + ' ' + toTimeInput.value);
                xaxisOptions.min = fromTime.getTime();
                xaxisOptions.max = toTime.getTime();
            }
        }

        webLogger.data('Chart x-axis options:', {
            min: new Date(xaxisOptions.min),
            max: new Date(xaxisOptions.max)
        });

        // Important: Make sure animations are enabled before updating series
        await this.combinedChart.updateOptions({
            chart: {
                animations: {
                    enabled: true,
                    easing: 'linear',
                    dynamicAnimation: {
                        speed: 1000
                    }
                }
            },
            xaxis: xaxisOptions
        }, false, false);
        
        // Then update the series to trigger animation
        await this.combinedChart.updateSeries(series, true);

        webLogger.page('Power chart updated successfully');
    }

    /**
     * updateStats:
     * Updates the widget values (mini widgets) based on power statistics data.
     * @param {object} stats - The power statistics returned from the API.
     */
    async updateStats(stats) {
        webLogger.data('UpdateStats - Raw stats:', stats);
        
        document.querySelectorAll('.stat-value').forEach(element => {
            const type = element.dataset.type;
            if (!type) return;
            
            const metricMap = {
                'realpower': 'ups_realpower',
                'voltage': 'input_voltage',
                'output_voltage': 'output_voltage',
                'load': 'ups_load',
                'nominal': 'ups_realpower_nominal'
            };

            const metricName = metricMap[type];
            if (!metricName || !stats[metricName]) return;

            const selectedRange = document.querySelector('.range-options a.active');
            const rangeType = selectedRange?.dataset.range;
            const metricData = stats[metricName];
            let value;

            // For non realtime modes, use the average instead of the current value
            if (type === 'realpower') {
                let displayValue;
                let unit = 'W';
                
                // Get the base value based on mode
                if (rangeType === 'realtime') {
                    // For realtime mode only, use current value
                    displayValue = metricData.current;
                } else {
                    // For today and historical data, show total energy in Watts
                    displayValue = metricData.total_energy;
                }

                // Format the value
                if (displayValue >= 1000) {
                    displayValue = displayValue / 1000;
                    unit = 'kW';
                }

                // Set the main value display
                element.textContent = `${displayValue.toFixed(2)} ${unit}`;

                // Add min/max info if available
                const trendElement = element.parentElement.querySelector('.stat-trend');
                if (trendElement && metricData.min !== undefined && metricData.max !== undefined) {
                    const minValue = metricData.min;
                    const maxValue = metricData.max;
                    trendElement.innerHTML = `<i class="fas fa-info-circle"></i> Min: ${minValue.toFixed(2)}W | Max: ${maxValue.toFixed(2)}W`;
                }
            } else {
                // For other metric types
                value = rangeType === 'realtime' ? metricData.current : metricData.avg;
                element.textContent = `${value.toFixed(1)}${type === 'load' ? '%' : 'V'}`;
            }
        });

        // Update the selected period in all cards
        const selectedRange = document.querySelector('.date-range-btn .selected-range');
        if (selectedRange) {
            document.querySelectorAll('.selected-period').forEach(span => {
                span.textContent = selectedRange.textContent;
            });
        }
    }

    /**
     * updateDisplayedRange:
     * Updates the displayed time range text in the dropdown button.
     * @param {string} text - The text to display.
     */
    updateDisplayedRange(text) {
        // Update the text in the button
        const selectedRange = document.querySelector('.date-range-btn .selected-range');
        if (selectedRange) {
            selectedRange.textContent = text;
        }

        // Update the text in all cards
        document.querySelectorAll('.selected-period').forEach(span => {
            span.textContent = text;
        });
    }

    /**
     * loadRealTimeData:
     * Fetches new power metrics and updates charts and widgets in real-time.
     */
    async loadRealTimeData() {
        try {
            const response = await fetch('/api/ups/cache');
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const result = await response.json();
            webLogger.console('Cache data received (raw):', result);
            
            if (result.success && result.data && Array.isArray(result.data)) {
                const data = result.data[1];  // Get the second element of the array
                webLogger.console('Cache data details:', data);

                // Format the data for the stats cards
                const statsData = {
                    ups_realpower: {
                        current: parseFloat(data.ups_realpower || 0),
                        min: parseFloat(data.ups_realpower || 0),
                        max: parseFloat(data.ups_realpower || 0),
                        avg: parseFloat(data.ups_realpower || 0)
                    },
                    input_voltage: {
                        current: parseFloat(data.input_voltage || 0),
                        min: parseFloat(data.input_voltage || 0),
                        max: parseFloat(data.input_voltage || 0),
                        avg: parseFloat(data.input_voltage || 0)
                    },
                    ups_load: {
                        current: parseFloat(data.ups_load || 0),
                        min: parseFloat(data.ups_load || 0),
                        max: parseFloat(data.ups_load || 0),
                        avg: parseFloat(data.ups_load || 0)
                    },
                    ups_realpower_nominal: {
                        current: parseFloat(data.ups_realpower_nominal || 0),
                        min: parseFloat(data.ups_realpower_nominal || 0),
                        max: parseFloat(data.ups_realpower_nominal || 0),
                        avg: parseFloat(data.ups_realpower_nominal || 0)
                    }
                };

                // Update the statistics
                this.updateStats(statsData);

                // Update the chart
                if (this.combinedChart) {
                    const timestamp = new Date().getTime();
                    
                    if (this.isFirstRealTimeUpdate) {
                        await this.combinedChart.updateSeries([
                            { name: 'Real Power', data: [] },
                            { name: 'Input Voltage', data: [] }
                        ]);
                        this.isFirstRealTimeUpdate = false;
                    }

                    const currentSeries = this.combinedChart.w.config.series;
                    const newSeries = [
                        {
                            name: 'Real Power',
                            data: [...(currentSeries[0]?.data || []), {
                                x: timestamp,
                                y: parseFloat(data.ups_realpower || 0)
                            }].slice(-30)
                        },
                        {
                            name: 'Input Voltage',
                            data: [...(currentSeries[1]?.data || []), {
                                x: timestamp,
                                y: parseFloat(data.input_voltage || 0)
                            }].slice(-30)
                        }
                    ];
                    
                    await this.combinedChart.updateSeries(newSeries);
                }
            }
        } catch (error) {
            console.error('Error loading real-time data:', error);
        }
    }

    /**
     * initEventListeners:
     * Sets up event listeners for UI elements such as the date range button.
     */
    async initEventListeners() {
        // Date range dropdown
        const dateRangeBtn = document.getElementById('dateRangeBtn');
        const dateRangeDropdown = document.getElementById('dateRangeDropdown');
        
        // Toggle dropdown
        if (dateRangeBtn) {
            dateRangeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dateRangeDropdown.classList.toggle('hidden');
            });
        }

        // Range options
        document.querySelectorAll('.range-options a').forEach(option => {
            option.addEventListener('click', async (e) => {
                e.preventDefault();
                const range = e.target.dataset.range;
                
                // Remove active from all options
                document.querySelectorAll('.range-options a').forEach(opt => {
                    opt.classList.remove('active');
                });
                e.target.classList.add('active');

                // Hide all panels
                document.querySelectorAll('.time-range-selector, .day-selector, .range-selector, .realtime-selector').forEach(selector => {
                    selector.classList.add('hidden');
                });

                switch(range) {
                    case 'realtime':
                        // Switch to realtime mode with Chart.js
                        document.getElementById('realtimeSelector').classList.remove('hidden');
                        this.isRealTimeMode = true;
                        this.startRealTimeUpdates();
                        break;
                    case 'today':
                        // Switch to historical mode with ApexCharts
                        document.getElementById('timeRangeSelector').classList.remove('hidden');
                        this.isRealTimeMode = false;
                        this.stopRealTimeUpdates();
                        break;
                    case 'day':
                        // Switch to historical mode with ApexCharts
                        document.getElementById('daySelectorPanel').classList.remove('hidden');
                        this.isRealTimeMode = false;
                        this.stopRealTimeUpdates();
                        break;
                    case 'range':
                        // Switch to historical mode with ApexCharts
                        document.getElementById('dateRangeSelectorPanel').classList.remove('hidden');
                        this.isRealTimeMode = false;
                        this.stopRealTimeUpdates();
                        break;
                }
            });
        });

        // Apply time range button
        const applyTimeRange = document.getElementById('applyTimeRange');
        if (applyTimeRange) {
            applyTimeRange.addEventListener('click', async () => {
                const fromTime = document.getElementById('fromTime').value;
                const toTime = document.getElementById('toTime').value;
                
                this.resetCharts();
                this.updateDisplayedRange(`Today (${fromTime} - ${toTime})`);
                await this.loadData('day', fromTime, toTime);
                dateRangeDropdown.classList.add('hidden');
            });
        }

        // Apply per Select Day
        const applyDay = document.getElementById('applyDay');
        if (applyDay) {
            applyDay.addEventListener('click', async () => {
                const selectedDate = document.getElementById('dayPicker').value;
                if (selectedDate) {
                    this.resetCharts();
                    this.isRealTimeMode = false;
                    this.stopRealTimeUpdates();
                    
                    const displayText = new Date(selectedDate).toLocaleDateString();
                    this.updateDisplayedRange(displayText);
                    
                    await this.loadData('day', selectedDate);
                    dateRangeDropdown.classList.add('hidden');
                }
            });
        }

        // Apply range button
        const applyRange = document.getElementById('applyRange');
        if (applyRange) {
            applyRange.addEventListener('click', async () => {
                const fromDate = document.getElementById('rangeFromDate').value;
                const toDate = document.getElementById('rangeToDate').value;
                if (fromDate && toDate) {
                    this.resetCharts();
                    const displayText = `${fromDate} to ${toDate}`;
                    this.updateDisplayedRange(displayText);
                    await this.loadData('range', fromDate, toDate);
                    dateRangeDropdown.classList.add('hidden');
                }
            });
        }

        // Apply realtime button
        const applyRealTime = document.getElementById('applyRealTime');
        if (applyRealTime) {
            applyRealTime.addEventListener('click', () => {
                const intervalInput = document.getElementById('realtimeInterval');
                const newInterval = parseInt(intervalInput.value);
                if (!isNaN(newInterval) && newInterval > 0) {
                    this.realTimeIntervalDuration = newInterval * 1000;
                    this.startRealTimeUpdates();
                    this.updateDisplayedRange(`Real Time (every ${newInterval}s)`);
                    dateRangeDropdown.classList.add('hidden');
                }
            });
        }

        // Click outside to close dropdown
        document.addEventListener('click', (e) => {
            if (dateRangeBtn && dateRangeDropdown && 
                !dateRangeBtn.contains(e.target) && 
                !dateRangeDropdown.contains(e.target)) {
                dateRangeDropdown.classList.add('hidden');
            }
        });
    }

    /**
     * showLoadingState:
     * Displays a loading overlay.
     * Uses the CSS defined in html.css.
     */
    showLoadingState() {
        // Minimal implementation: create and show a loading overlay if not already present.
        let overlay = document.getElementById('loading-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            overlay.innerHTML = '<div class="loading-spinner"></div>';
            document.body.appendChild(overlay);
        }
        overlay.style.display = 'flex';
    }

    /**
     * hideLoadingState:
     * Hides the loading overlay.
     */
    hideLoadingState() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    /**
     * addLoadingStyles:
     * This method is intentionally minimal and does not add extra CSS.
     * It relies on the CSS provided in static/css/html.css.
     */
    addLoadingStyles() {
        // Removed custom CSS in favor of CSS from html.css.
    }

    startRealTimeUpdates() {
        webLogger.console("Starting realtime updates");
        this.isFirstRealTimeUpdate = true;
        this.isRealTimeMode = true;
        
        if (this.realTimeInterval) {
            webLogger.console("Clearing existing interval");
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }
        
        // If we have an existing ApexCharts, destroy it
        if (this.combinedChart) {
            this.combinedChart.destroy();
            this.combinedChart = null;
        }
        
        const combinedChartElement = document.querySelector("#combinedPowerChart");
        if (combinedChartElement) {
            // Load Chart.js libraries dynamically and initialize the chart
            this.loadChartJSLibraries()
                .then(() => {
                    this.initRealtimeChartJS(combinedChartElement);
                })
                .catch(error => {
                    webLogger.error('Error loading Chart.js libraries:', error);
                    // Fallback to using ApexCharts for realtime too if Chart.js fails
                    this.initCombinedChart(combinedChartElement);
                    this.loadRealTimeData();
                    this.realTimeInterval = setInterval(() => {
                        this.loadRealTimeData();
                    }, this.realTimeIntervalDuration || 1000);
                });
        }
    }

    stopRealTimeUpdates() {
        webLogger.console('Stopping realtime updates');
        
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }
        
        this.isRealTimeMode = false;
        
        // Clean up Chart.js if it exists
        if (this.powerChartJS) {
            this.powerChartJS.destroy();
            this.powerChartJS = null;
        }
        
        // Reinitialize ApexCharts for non-realtime mode
        const combinedChartElement = document.querySelector("#combinedPowerChart");
        if (combinedChartElement) {
            combinedChartElement.innerHTML = '';
            this.initCombinedChart(combinedChartElement);
        }
    }

    resetCharts() {
        webLogger.data("Resetting charts");
        if (this.combinedChart) {
            webLogger.data("Resetting series data");
            // Temporarily disable animations during reset
            this.combinedChart.updateOptions({
                chart: {
                    animations: {
                        enabled: false
                    }
                }
            }, false, false);

            this.combinedChart.updateSeries([
                { name: 'Real Power', data: [] },
                { name: 'Input Voltage', data: [] }
            ], false);

            // Re-enable animations after reset
            this.combinedChart.updateOptions({
                chart: {
                    animations: {
                        enabled: true,
                        easing: 'linear',
                        dynamicAnimation: {
                            speed: 1000
                        }
                    }
                }
            }, false, false);
        } else {
            webLogger.error("Chart not available for reset");
        }
    }

    formatChartDate(timestamp) {
        return new Date(timestamp).toLocaleString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    formatTooltipDate(val) {
        return new Date(val).toLocaleString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    showError(message) {
        console.error(message);
        webLogger.error(message);
    }

    async checkHistoricalData() {
        try {
            const now = new Date();
            const currentTime = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? 
                window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });
            
            const params = new URLSearchParams({
                period: 'today',
                from_time: '00:00',
                to_time: currentTime
            });

            const [historyResponse, statsResponse] = await Promise.all([
                fetch(`/api/power/history?${params}`),
                fetch(`/api/power/stats?${params}`)
            ]);

            const historyData = await historyResponse.json();
            const statsData = await statsResponse.json();

            webLogger.data('History data check:', {
                history: historyData,
                stats: statsData
            });

            // Check if there is valid historical data
            if (historyData.success && historyData.data) {
                const powerData = historyData.data.ups_realpower || [];
                const voltageData = historyData.data.input_voltage || [];

                // Check if there is at least 2 different data points to consider them historical
                const hasHistoricalPowerData = powerData.length >= 2 && 
                    powerData.slice(0, -1).some(p => parseFloat(p.value) > 0); // Exclude the last point (it might be live)

                const hasHistoricalVoltageData = voltageData.length >= 2 && 
                    voltageData.slice(0, -1).some(v => parseFloat(v.value) > 0); // Exclude the last point (it might be live)

                // Check if there is valid historical stats
                const hasHistoricalStats = statsData.success && 
                                         statsData.data && 
                                         statsData.data.ups_realpower && 
                                         (
                                             statsData.data.ups_realpower.total_energy > 0 ||
                                             (
                                                 statsData.data.ups_realpower.min !== statsData.data.ups_realpower.max &&
                                                 statsData.data.ups_realpower.min > 0
                                             )
                                         );

                const hasHistoricalData = hasHistoricalPowerData || hasHistoricalVoltageData || hasHistoricalStats;

                webLogger.data('Historical data analysis:', {
                    hasHistoricalPowerData,
                    hasHistoricalVoltageData,
                    hasHistoricalStats,
                    powerDataPoints: powerData.length,
                    voltageDataPoints: voltageData.length
                });

                return hasHistoricalData;
            }

            return false;
        } catch (error) {
            webLogger.error('Error checking historical power data:', error);
            return false;
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `<i class="fas fa-info-circle"></i><span>${message}</span>`;
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    startRealTimeMode() {
        this.isRealTimeMode = true;
        this.initialLoadTime = new Date();
        
        // Reset the chart before starting
        if (this.combinedChart) {
            this.resetCharts();
        }
        
        // Start the timer for the mode check
        this.modeCheckInterval = setInterval(() => {
            this.checkInitialMode();
        }, 30000); // Check every 30 seconds
    }

    stopRealTimeMode() {
        if (this.modeCheckInterval) {
            clearInterval(this.modeCheckInterval);
        }
        this.isRealTimeMode = false;
    }

    async checkInitialMode() {
        const now = new Date();
        const timeElapsed = now - this.initialLoadTime;

        if (this.isRealTimeMode && timeElapsed >= this.REALTIME_DURATION) {
            webLogger.page('Switching to Today mode after 5 minutes');
            this.isRealTimeMode = false;
            
            // Switch to Today
            const currentTime = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? 
                window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });

            // Update UI
            document.querySelectorAll('.range-options a').forEach(option => {
                option.classList.remove('active');
                if (option.dataset.range === 'today') {
                    option.classList.add('active');
                }
            });

            this.updateDisplayedRange(`Today (00:00 - ${currentTime})`);
            this.stopRealTimeUpdates();
            await this.loadData('day', '00:00', currentTime);
            return false;
        }
        return this.isRealTimeMode;
    }

    // Dynamic library loading to avoid conflicts
    loadChartJSLibraries() {
        return new Promise((resolve, reject) => {
            // Check if Chart.js is already loaded
            if (window.Chart) {
                resolve();
                return;
            }

            // Load Chart.js and its streaming plugin dynamically
            const chartJS = document.createElement('script');
            chartJS.src = '/static/js/lib/chartjs/chart.min.js';
            
            chartJS.onload = () => {
                // After Chart.js is loaded, load the streaming plugin
                const streamingPlugin = document.createElement('script');
                streamingPlugin.src = '/static/js/lib/chartjs/chartjs-plugin-streaming.min.js';
                
                streamingPlugin.onload = () => {
                    // Both libraries loaded successfully
                    resolve();
                };
                
                streamingPlugin.onerror = () => {
                    reject(new Error('Failed to load chartjs-plugin-streaming'));
                };
                
                document.head.appendChild(streamingPlugin);
            };
            
            chartJS.onerror = () => {
                reject(new Error('Failed to load Chart.js'));
            };
            
            document.head.appendChild(chartJS);
        });
    }

    // New method to initialize Chart.js for realtime mode only
    initRealtimeChartJS(container) {
        webLogger.page('Initializing Chart.js for realtime power monitoring');
        
        // Clear the container
        container.innerHTML = '';
        
        // Create a canvas for Chart.js
        const canvas = document.createElement('canvas');
        canvas.id = 'realtimePowerChart';
        container.appendChild(canvas);
        
        const ctx = canvas.getContext('2d');
        
        // Create gradients for series
        const powerGradient = ctx.createLinearGradient(0, 0, 0, 300);
        powerGradient.addColorStop(0, 'rgba(102, 218, 38, 0.3)');
        powerGradient.addColorStop(1, 'rgba(102, 218, 38, 0.0)');
        
        const voltageGradient = ctx.createLinearGradient(0, 0, 0, 300);
        voltageGradient.addColorStop(0, 'rgba(255, 152, 0, 0.3)');
        voltageGradient.addColorStop(1, 'rgba(255, 152, 0, 0.0)');
        
        // Chart.js configuration for power monitoring
        const chartConfig = {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Real Power',
                        backgroundColor: powerGradient,
                        borderColor: '#66DA26',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true,
                        cubicInterpolationMode: 'monotone',
                        yAxisID: 'y-power'
                    },
                    {
                        label: 'Input Voltage',
                        backgroundColor: voltageGradient,
                        borderColor: '#FF9800',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: true,
                        cubicInterpolationMode: 'monotone',
                        yAxisID: 'y-voltage'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    streaming: {
                        duration: 60000, // Show 60 seconds of data
                        refresh: 1000,   // Refresh every second
                        delay: 1000,     // 1 second delay
                        onRefresh: this.onChartRefresh.bind(this)
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
                    'y-power': {
                        position: 'left',
                        min: 0,
                        max: (context) => {
                            if (context.chart.data.datasets[0].data.length > 0) {
                                let maxValue = Math.max(...context.chart.data.datasets[0].data.map(d => d.y));
                                return Math.max(100, Math.ceil(maxValue * 1.2));
                            }
                            return 100;
                        },
                        grid: { display: false },
                        ticks: {
                            color: '#66DA26'
                        },
                        title: {
                            display: true,
                            text: 'Real Power (W)',
                            color: '#66DA26'
                        }
                    },
                    'y-voltage': {
                        position: 'right',
                        min: (context) => {
                            if (context.chart.data.datasets[1].data.length > 0) {
                                let minValue = Math.min(...context.chart.data.datasets[1].data.map(d => d.y));
                                return Math.max(0, Math.floor(minValue * 0.9));
                            }
                            return 0;
                        },
                        max: (context) => {
                            if (context.chart.data.datasets[1].data.length > 0) {
                                let maxValue = Math.max(...context.chart.data.datasets[1].data.map(d => d.y));
                                return Math.ceil(maxValue * 1.1);
                            }
                            return 250;
                        },
                        grid: { display: false },
                        ticks: {
                            color: '#FF9800'
                        },
                        title: {
                            display: true,
                            text: 'Input Voltage (V)',
                            color: '#FF9800'
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
        this.powerChartJS = new Chart(ctx, chartConfig);
        
        // Initialize data buffers for smoothing
        this.dataBuffer = {
            power: [],
            voltage: []
        };
        this.bufferSize = 15; // Buffer size for data smoothing
    }

    // New method to handle realtime chart refreshes
    onChartRefresh(chart) {
        return fetch('/api/ups/cache')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data && Array.isArray(result.data)) {
                    const data = result.data[1];
                    let powerValue = parseFloat(data.ups_realpower || 0);
                    let voltageValue = parseFloat(data.input_voltage || 0);
                    
                    // Ensure values are never zero or negative
                    powerValue = Math.max(powerValue, 1);
                    voltageValue = Math.max(voltageValue, 1);
                    
                    const now = Date.now();

                    // Add new points to the buffers
                    this.dataBuffer.power.push({
                        x: now,
                        y: powerValue
                    });
                    this.dataBuffer.voltage.push({
                        x: now,
                        y: voltageValue
                    });

                    // Maintain buffer size
                    if (this.dataBuffer.power.length > this.bufferSize) {
                        this.dataBuffer.power.shift();
                    }
                    if (this.dataBuffer.voltage.length > this.bufferSize) {
                        this.dataBuffer.voltage.shift();
                    }

                    // Calculate smoothed values using the buffers
                    const smoothedPower = this.calculateSmoothedValue(this.dataBuffer.power);
                    const smoothedVoltage = this.calculateSmoothedValue(this.dataBuffer.voltage);
                    
                    // Add smoothed points to the chart
                    chart.data.datasets[0].data.push({
                        x: now,
                        y: smoothedPower
                    });
                    chart.data.datasets[1].data.push({
                        x: now,
                        y: smoothedVoltage
                    });
                    
                    // Create stats data structure for the updateRealtimeStats method
                    const statsData = {
                        ups_realpower: {
                            current: powerValue,
                            min: powerValue,
                            max: powerValue,
                            avg: powerValue,
                            value: powerValue
                        },
                        input_voltage: {
                            current: voltageValue,
                            min: voltageValue,
                            max: voltageValue,
                            avg: voltageValue,
                            value: voltageValue
                        },
                        ups_load: {
                            current: parseFloat(data.ups_load || 0),
                            min: parseFloat(data.ups_load || 0),
                            max: parseFloat(data.ups_load || 0),
                            avg: parseFloat(data.ups_load || 0),
                            value: parseFloat(data.ups_load || 0)
                        },
                        ups_realpower_nominal: {
                            current: parseFloat(data.ups_realpower_nominal || 0),
                            min: parseFloat(data.ups_realpower_nominal || 0),
                            max: parseFloat(data.ups_realpower_nominal || 0),
                            avg: parseFloat(data.ups_realpower_nominal || 0),
                            value: parseFloat(data.ups_realpower_nominal || 0)
                        },
                        status: {
                            value: data.ups_status || 'Unknown'
                        }
                    };
                    
                    // Update the stats with current values using a special method
                    this.updateRealtimeStats(statsData);
                    
                    chart.update('quiet');
                }
            })
            .catch(error => console.error('Error fetching power data for chart:', error));
    }

    // New method specifically for realtime stats updates to avoid conflicts
    updateRealtimeStats(stats) {
        webLogger.data('Updating realtime stats:', stats);
        
        // Update stat values
        document.querySelectorAll('.stat-value').forEach(element => {
            const type = element.dataset.type;
            if (!type) return;
            
            const metricMap = {
                'realpower': 'ups_realpower',
                'voltage': 'input_voltage',
                'output_voltage': 'output_voltage',
                'load': 'ups_load',
                'nominal': 'ups_realpower_nominal'
            };

            const metricName = metricMap[type];
            if (!metricName || !stats[metricName]) return;

            const metricData = stats[metricName];
            
            // For realtime mode, display the current value
            if (type === 'realpower') {
                const powerValue = metricData.value || metricData.current;
                element.textContent = `${powerValue.toFixed(1)}W`;
                
                // Update min/max info
                const trendElement = element.parentElement.querySelector('.stat-trend');
                if (trendElement) {
                    trendElement.innerHTML = `<i class="fas fa-info-circle"></i> Min: ${powerValue.toFixed(1)}W | Max: ${powerValue.toFixed(1)}W`;
                }
            } else if (type === 'voltage' || type === 'output_voltage') {
                const voltageValue = metricData.value || metricData.current;
                element.textContent = `${voltageValue.toFixed(1)}V`;
            } else if (type === 'load') {
                const loadValue = metricData.value || metricData.current;
                element.textContent = `${loadValue.toFixed(1)}%`;
            } else if (type === 'nominal') {
                // Check in order: ups_realpower_nominal, ups_power_nominal, then keep existing value
                if (stats.ups_realpower_nominal && stats.ups_realpower_nominal.value > 0) {
                    const value = stats.ups_realpower_nominal.value || stats.ups_realpower_nominal.current;
                    element.textContent = `${value.toFixed(1)}W`;
                    // Update the label to "Nominal Power"
                    const labelElement = element.parentElement.querySelector('.info-label');
                    if (labelElement) labelElement.textContent = 'Nominal Power:';
                } else if (stats.ups_power_nominal && stats.ups_power_nominal.value > 0) {
                    const value = stats.ups_power_nominal.value || stats.ups_power_nominal.current;
                    element.textContent = `${value.toFixed(1)}W`;
                    // Update the label to "Nominal Power"
                    const labelElement = element.parentElement.querySelector('.info-label');
                    if (labelElement) labelElement.textContent = 'Nominal Power:';
                }
                // If neither is available, keep the existing value and label (Manual Nominal Power)
            } else if (type === 'status' && stats.status) {
                const value = stats.status.value || stats.status.current;
                element.textContent = this.formatUPSStatus(value);
            }
        });

        // Update the status information if available
        document.querySelectorAll('.info-value').forEach(element => {
            const type = element.dataset.type;
            if (!type) return;
            
            if (type === 'load' && stats.ups_load) {
                const value = stats.ups_load.value || stats.ups_load.current;
                element.textContent = `${value.toFixed(1)}%`;
            } else if (type === 'nominal') {
                // Check in order: ups_realpower_nominal, ups_power_nominal, then keep existing value
                if (stats.ups_realpower_nominal && stats.ups_realpower_nominal.value > 0) {
                    const value = stats.ups_realpower_nominal.value || stats.ups_realpower_nominal.current;
                    element.textContent = `${value.toFixed(1)}W`;
                    // Update the label to "Nominal Power"
                    const labelElement = element.parentElement.querySelector('.info-label');
                    if (labelElement) labelElement.textContent = 'Nominal Power:';
                } else if (stats.ups_power_nominal && stats.ups_power_nominal.value > 0) {
                    const value = stats.ups_power_nominal.value || stats.ups_power_nominal.current;
                    element.textContent = `${value.toFixed(1)}W`;
                    // Update the label to "Nominal Power"
                    const labelElement = element.parentElement.querySelector('.info-label');
                    if (labelElement) labelElement.textContent = 'Nominal Power:';
                }
                // If neither is available, keep the existing value and label (Manual Nominal Power)
            } else if (type === 'status' && stats.status) {
                const value = stats.status.value || stats.status.current;
                element.textContent = this.formatUPSStatus(value);
            }
        });
    }

    // New method to calculate smoothed values
    calculateSmoothedValue(buffer) {
        if (buffer.length === 0) return 0;
        
        // Use a weighted smoothing algorithm
        const weights = [];
        for (let i = 0; i < buffer.length; i++) {
            // Formula to give more weight to recent values
            weights.push(Math.pow(1.2, i));
        }
        
        const weightSum = weights.reduce((a, b) => a + b, 0);
        
        // Calculate weighted average
        let smoothedValue = 0;
        for (let i = 0; i < buffer.length; i++) {
            smoothedValue += buffer[i].y * weights[i];
        }
        
        return smoothedValue / weightSum;
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
}

// Initialize PowerPage once the DOM is fully loaded.
document.addEventListener('DOMContentLoaded', () => {
    new PowerPage();
}); 