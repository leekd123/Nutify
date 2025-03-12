class EnergyPage extends BasePage {
    constructor() {
        super();
        webLogger.enable(false);
        webLogger.page('Initializing EnergyPage');
        
        this.costTrendChart = null;
        this.usagePatternChart = null;
        this.currency = 'EUR';
        this.pricePerKwh = 0;
        this.co2Factor = 0;
        this.efficiencyFactor = 0;
        this.realtimeInterval = null;
        this.fromDate = null;
        this.toDate = null;
        this.isRealTimeMode = true;
        
        webLogger.data('Setting up initial configuration');
        this.bindModalCloseEvent();

        const usagePatternChart = document.querySelector('#usagePatternChart');
        if (usagePatternChart) {
            const container = usagePatternChart.closest('.card');
            if (container) {
                container.classList.add('usage-pattern-card');
                if (this.isRealTimeMode) {
                    container.classList.add('hidden');
                }
            }
        }

        (async () => {
            try {
                // Load variables first
                await this.loadVariables();
                
                // Check if there is data in the database
                const now = new Date();
                const currentTime = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? 
                    window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });

                // Check if there is historical data in the last 5 minutes
                const response = await fetch(`/api/energy/data?type=today&from_time=00:00&to_time=${currentTime}`);
                const data = await response.json();

                const hasEnoughData = data && 
                                     data.totalEnergy !== undefined && 
                                     parseFloat(data.totalEnergy) > 0;  // Check if there is consumed energy

                if (!hasEnoughData) {
                    // If there is no data, start in RealTime mode
                    webLogger.page('No historical data found, starting in RealTime mode');
                    this.isRealTimeMode = true;
                    
                    // Update the UI
                    this.updateDisplayedRange('Real Time');
                    document.querySelectorAll('.range-options a').forEach(option => {
                        option.classList.remove('active');
                        if (option.dataset.range === 'realtime') {
                            option.classList.add('active');
                        }
                    });

                    // Initialize charts for realtime mode
                    this.initRealtimeCostTrendChart();
                    
                    // Hide Daily Cost Distribution chart and adjust layout
                    const dailyDistributionCard = document.getElementById('dailyDistributionCard');
                    if (dailyDistributionCard) {
                        dailyDistributionCard.style.display = 'none';
                    }
                    const chartsContainer = document.getElementById('chartsContainer');
                    if (chartsContainer) {
                        chartsContainer.style.gridTemplateColumns = '1fr';
                    }

                    // Start realtime updates
                    this.startRealTimeUpdates();
                } else {
                    // If there is data, start in Today mode
                    this.isRealTimeMode = false;
                    
                    // Initialize normal charts
                    this.initCharts();
                    
                    // Set the values of the time fields
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
                    
                    // Load today data
                    await this.loadData('today', '00:00', currentTime);
                }

                // Initialize socket listeners
                this.initSocketListeners();

            } catch (error) {
                console.error('Error during initialization:', error);
            }
        })();
    }

    async init() {
        webLogger.console('Starting EnergyPage initialization');
        try {
            // Load variables and initialize charts, listeners and socket
            await this.loadVariables();
            this.initCharts();
            this.initEventListeners();
            this.initSocketListeners();

            // Get the current time
            const now = new Date();
            const currentTime = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });

            // Set Today as default in the dropdown menu
            const dateRangeBtn = document.getElementById('dateRangeBtn');
            const dateRangeDropdown = document.getElementById('dateRangeDropdown');
            if (dateRangeBtn && dateRangeDropdown) {
                const todayOption = dateRangeDropdown.querySelector('a[data-range="0"]');
                if (todayOption) {
                    dateRangeDropdown.querySelectorAll('a').forEach(a => a.classList.remove('active'));
                    todayOption.classList.add('active');
                }
                const timeRange = `Today (00:00 - ${currentTime})`;
                const selectedRange = dateRangeBtn.querySelector('.selected-range');
                if (selectedRange) {
                    selectedRange.textContent = timeRange;
                }
                document.querySelectorAll('.selected-period').forEach(span => {
                    span.textContent = timeRange;
                });
            }

            // Check if the database is populated
            const hasEnoughData = await this.checkHistoricalData();
            if (hasEnoughData) {
                await this.loadData('today', '00:00', currentTime);
            } else {
                this.showNotification('Database in phase of population - Real Time mode activated', 'warning');
                document.querySelectorAll('.range-options a').forEach(option => {
                    option.classList.remove('active');
                    if (option.dataset.range === 'realtime') {
                        option.classList.add('active');
                    }
                });
                this.updateDisplayedRange('Real Time');
                this.startRealtimeUpdates();
                this.hideLoadingState();
            }

            webLogger.console('EnergyPage initialization completed');
        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }

    async loadVariables() {
        try {
            const response = await fetch('/api/settings/variables');
            const data = await response.json();
            if (data.success && data.data) {
                this.currency = data.data.currency;
                this.pricePerKwh = parseFloat(data.data.price_per_kwh);
                this.co2Factor = parseFloat(data.data.co2_factor);
                this.efficiencyFactor = parseFloat(data.data.efficiency_factor);
                
                // Update the displayed value
                const rateValueElement = document.querySelector('.rate_value');
                if (rateValueElement) {
                    const currencySymbol = this.getCurrencySymbol(this.currency);
                    rateValueElement.textContent = `${this.pricePerKwh.toFixed(4)}${currencySymbol}/kWh`;
                }

                // Update cost icon in "Total Cost" widget based on the selected currency
                const costIcon = document.querySelector('.stat_card[data-type="cost"] .stat-icon i');
                if (costIcon) {
                    costIcon.classList.remove('fa-euro-sign', 'fa-dollar-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-ruble-sign');
                    if (this.currency === 'EUR') {
                        costIcon.classList.add('fa-euro-sign');
                    } else if (this.currency === 'USD') {
                        costIcon.classList.add('fa-dollar-sign');
                    } else if (this.currency === 'GBP') {
                        costIcon.classList.add('fa-pound-sign');
                    } else if (this.currency === 'JPY' || this.currency === 'CNY') {
                        costIcon.classList.add('fa-yen-sign');
                    } else if (this.currency === 'CHF') {
                        costIcon.classList.add('fa-franc-sign');
                    } else if (this.currency === 'INR') {
                        costIcon.classList.add('fa-rupee-sign');
                    } else if (this.currency === 'RUB') {
                        costIcon.classList.add('fa-ruble-sign');
                    } else if (this.currency === 'KRW') {
                        costIcon.classList.add('fa-won-sign');
                    } else {
                        costIcon.classList.add('fa-dollar-sign');
                    }
                }
            }
        } catch (error) {
            console.error('Error loading variables:', error);
        }
    }

    getCurrencySymbol(currency) {
        const symbols = {
            'EUR': '€',
            'USD': '$',
            'GBP': '£',
            'JPY': '¥',
            'AUD': 'A$',
            'CAD': 'C$',
            'CHF': 'Fr',
            'CNY': '¥',
            'INR': '₹',
            'NZD': 'NZ$',
            'BRL': 'R$',
            'RUB': '₽',
            'KRW': '₩'
        };
        return symbols[currency] || currency;
    }

    initCharts() {
        this.initCostTrendChart();
        this.initUsagePatternChart();
    }

    async loadData(period = 'day', fromTime = null, toTime = null) {
        try {
            webLogger.data('Loading energy data', { period, fromTime, toTime });
            
            // Save the date range for 'range'
            if (period === 'range') {
                this.fromDate = fromTime;
                this.toDate = toTime;
            }
            
            const params = new URLSearchParams();
            if (fromTime) params.append('from_time', fromTime);
            if (toTime) params.append('to_time', toTime);
            params.append('type', period);
            
            webLogger.data('Fetching data with params', Object.fromEntries(params));
            const response = await fetch(`/api/energy/data?${params}`);
            const data = await response.json();
            
            webLogger.data('Received energy data', data);

            if (data) {
                await this.updateStatsCards(data);
                await this.updateCostTrendChart(period, fromTime, toTime);
                await this.updateUsagePatternChart(period, { from_time: fromTime, to_time: toTime });
                webLogger.page('Energy data updated successfully');
            }
        } catch (error) {
            webLogger.error('Error loading energy data', error);
            this.showError('Failed to load energy data');
        }
    }

    async fetchData(params) {
        try {
            webLogger.console('=== START fetchData ===');
            const url = `/api/energy/data?${params.toString()}`;
            
            webLogger.console('Fetching URL:', url);
            webLogger.console('Parameters:', Object.fromEntries(params));
            
            const response = await fetch(url);
            webLogger.console('Response status:', response.status);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('API Error Response:', errorText);
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            webLogger.console('API Response data:', data);
            return data;
        } catch (error) {
            console.error('Fetch error:', error);
            this.showError(`Failed to fetch data: ${error.message}`);
            return null;
        }
    }

    formatTime(time) {
        if (!time) return null;
        if (/^\d{2}:\d{2}$/.test(time)) return time;
        const [hours, minutes] = time.split(':');
        return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
    }

    /**
     * Updates statistics cards based on the selected time range
     * @param {Object} data - Data from API
     * @param {string} timeRange - Current time range mode
     */
    async updateStatsCards(data) {
        webLogger.console('=== START updateStatsCards ===');
        webLogger.console('Updating stats with data:', data);
        
        if (!data || typeof data !== 'object') {
            console.error('Invalid data structure for stats cards');
            return;
        }

        // Ensure all values are positive or zero
        const stats = {
            energy: Math.max(0, data.totalEnergy || data.total_energy || 0),
            cost: Math.max(0, data.totalCost || data.total_cost || 0),
            load: Math.max(0, Math.min(100, data.avgLoad || data.avg_load || 0)),
            co2: Math.max(0, data.co2 || 0)
        };

        // Update the values in the stat cards
        Object.entries(stats).forEach(([type, value]) => {
            const valueElement = document.querySelector(`.stat-value[data-type="${type}"]`);
            if (valueElement) {
                if (type === 'cost') {
                    if (this.isRealTimeMode) {
                        valueElement.textContent = `${this.getCurrencySymbol(this.currency)}${value.toFixed(4)}`;
                    } else {
                        valueElement.textContent = `${this.getCurrencySymbol(this.currency)}${value.toFixed(2)}`;
                    }
                } else if (type === 'energy') {
                    if (this.isRealTimeMode) {
                        // Don't modify the realtime behavior
                        const watts = value;
                        if (watts < 1000) {
                            valueElement.textContent = `${watts.toFixed(1)} W`;
                        } else {
                            valueElement.textContent = `${(watts/1000).toFixed(2)} kW`;
                        }
                    } else {
                        // For historical data use Wh under 1000, kWh above 1000
                        const wh = parseFloat(value);
                        if (wh < 1000) {
                            valueElement.textContent = `${wh.toFixed(1)} Wh`;
                        } else {
                            valueElement.textContent = `${(wh/1000).toFixed(2)} kWh`;
                        }
                    }
                } else if (type === 'load') {
                    const loadValue = parseFloat(value);
                    if (!isNaN(loadValue)) {
                        valueElement.textContent = `${loadValue.toFixed(1)}%`;
                    } else {
                        valueElement.textContent = '0.0%';
                    }
                } else if (type === 'co2') {
                    valueElement.textContent = `${value.toFixed(2)} kg`;
                }
            }
        });

        // Update trends if available
        if (data.trends) {
            this.updateTrends(data.trends);
        }

        webLogger.console('=== END updateStatsCards ===');
    }

    // Graph Energy cost trend //
    initCostTrendChart() {
        webLogger.chart('Initializing cost trend chart');
        const self = this;
        
        const options = {
            chart: {
                type: 'bar',
                height: 350,
                animations: {
                    enabled: true,
                    easing: 'linear',
                    dynamicAnimation: {
                        speed: 1000
                    }
                },
                events: {
                    dataPointSelection: (event, chartContext, config) => {
                        // Debug log to see the timestamp format
                        webLogger.console('Selected data point:', {
                            dataPointIndex: config.dataPointIndex,
                            seriesIndex: config.seriesIndex,
                            data: config.w.config.series[0].data[config.dataPointIndex]
                        });
                        
                        const dataPoint = config.w.config.series[0].data[config.dataPointIndex];
                        // Check if the dataPoint is an array or an object
                        const timestamp = Array.isArray(dataPoint) ? dataPoint[0] : dataPoint.x;
                        
                        webLogger.console('Extracted timestamp:', timestamp);
                        webLogger.console('Date object:', new Date(timestamp));
                        
                        this.showDetailModal(timestamp);
                    }
                }
            },
            plotOptions: {
                bar: {
                    horizontal: false,
                    columnWidth: '60%',
                    borderRadius: 4
                }
            },
            dataLabels: {
                enabled: false
            },
            xaxis: {
                type: 'datetime',
                labels: {
                    datetimeUTC: false,
                    format: 'HH:mm:ss'
                }
            },
            yaxis: {
                title: {
                    text: 'Energy Cost'
                }
            },
            tooltip: {
                x: {
                    format: 'HH:mm:ss'
                },
                y: {
                    formatter: function(value) {
                        // Calculate watt using the formula: watt = (cost * 1000) / pricePerKwh
                        let watt = self.pricePerKwh > 0 ? (value * 1000 / self.pricePerKwh) : 0;
                        return `${self.getCurrencySymbol(self.currency)}${value.toFixed(2)} ( ${watt.toFixed(1)} W )`;
                    }
                }
            },
            series: [{
                name: 'Energy Cost',
                data: []
            }]
        };

        webLogger.chart('Creating cost trend chart with options', options);
        this.costTrendChart = new ApexCharts(document.querySelector("#costTrendChart"), options);
        this.costTrendChart.render();
    }

    initUsagePatternChart() {
        const options = {
            chart: {
                type: 'donut',
                height: '350'
            },
            series: [0, 0, 0, 0],  // Initial values for the 4 ranges
            labels: [
                'Morning (6-12)',
                'Afternoon (12-18)',
                'Evening (18-23)',
                'Night (23-6)'
            ],
            colors: ['#ffd700', '#ff8c00', '#4b0082', '#191970'],
            plotOptions: {
                pie: {
                    donut: {
                        size: '70%',
                        labels: {
                            show: true,
                            name: {
                                show: true,
                                fontSize: '14px',
                                fontFamily: 'Helvetica, Arial, sans-serif',
                                color: '#373d3f'
                            },
                            value: {
                                show: true,
                                fontSize: '16px',
                                fontFamily: 'Helvetica, Arial, sans-serif',
                                color: '#373d3f',
                                formatter: function (val) {
                                    const numVal = parseFloat(val);
                                    return !isNaN(numVal) ? 
                                        `${this.getCurrencySymbol(this.currency)}${numVal.toFixed(2)}` : 
                                        `${this.getCurrencySymbol(this.currency)}0.00`;
                                }.bind(this)
                            },
                            total: {
                                show: true,
                                label: 'Total',
                                color: '#373d3f',
                                formatter: function (w) {
                                    const total = w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                                    return `${this.getCurrencySymbol(this.currency)}${isNaN(total) ? '0.00' : total.toFixed(2)}`;
                                }.bind(this)
                            }
                        }
                    }
                }
            },
            legend: {
                position: 'bottom',
                formatter: function(label, opts) {
                    const val = opts.w.globals.series[opts.seriesIndex];
                    const numVal = parseFloat(val);
                    return `${label}: ${this.getCurrencySymbol(this.currency)}${!isNaN(numVal) ? numVal.toFixed(2) : '0.00'}`;
                }.bind(this)
            },
            tooltip: {
                y: {
                    formatter: function (val) {
                        const numVal = parseFloat(val);
                        return `${this.getCurrencySymbol(this.currency)}${!isNaN(numVal) ? numVal.toFixed(2) : '0.00'}`;
                    }.bind(this)
                }
            }
        };
        this.usagePatternChart = new ApexCharts(document.querySelector('#usagePatternChart'), options);
        this.usagePatternChart.render();
    }

    initEventListeners() {
        webLogger.console('Initializing event listeners');
        
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
            toTimeInput.value = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });
        }

        if (dateRangeBtn) {
            dateRangeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                dateRangeDropdown.classList.toggle('hidden');
            });
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!dateRangeBtn.contains(e.target) && !dateRangeDropdown.contains(e.target)) {
                dateRangeDropdown.classList.add('hidden');
            }
        });

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

                // Hide all selectors
                document.querySelectorAll('.date-range-dropdown > div:not(.range-options)').forEach(div => {
                    div.classList.add('hidden');
                });

                switch(range) {
                    case 'realtime':
                        webLogger.console("Menu realtime clicked");
                        document.getElementById('realtimeSelector').classList.remove('hidden');
                        this.updateDisplayedRange('Real Time');
                        this.isRealTimeMode = true;
                        this.startRealTimeUpdates();
                        break;
                        
                    case 'today':
                        this.stopRealtimeUpdates();
                        this.setNormalLayout();
                        document.getElementById('timeRangeSelector').classList.remove('hidden');
                        const currentTime = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? 
                            window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });
                        this.updateDisplayedRange(`Today (00:00 - ${currentTime})`);
                        await this.loadData('today', '00:00', currentTime);
                        break;
                        
                    case 'day':
                        this.stopRealtimeUpdates();
                        this.setNormalLayout();
                        document.getElementById('daySelectorPanel').classList.remove('hidden');
                        break;
                        
                    case 'range':
                        this.stopRealtimeUpdates();
                        this.setNormalLayout();
                        document.getElementById('dateRangeSelectorPanel').classList.remove('hidden');
                        break;
                }
            });
        });

        // Apply time range button
        if (applyTimeRange) {
            applyTimeRange.addEventListener('click', async () => {
                const fromTime = document.getElementById('fromTime').value;
                const toTime = document.getElementById('toTime').value;
                
                this.setNormalLayout();
                this.updateDisplayedRange(`Today (${fromTime} - ${toTime})`);
                await this.loadData('today', fromTime, toTime);
                dateRangeDropdown.classList.add('hidden');
            });
        }

        // Apply Day button
        const applyDay = document.getElementById('applyDay');
        if (applyDay) {
            applyDay.addEventListener('click', async () => {
                const selectedDate = document.getElementById('dayPicker').value;
                if (selectedDate) {
                    this.setNormalLayout();
                    const displayText = new Date(selectedDate).toLocaleDateString();
                    this.updateDisplayedRange(displayText);
                    await this.loadData('day', selectedDate);
                    dateRangeDropdown.classList.add('hidden');
                }
            });
        }

        // Apply Range button
        const applyRange = document.getElementById('applyRange');
        if (applyRange) {
            applyRange.addEventListener('click', async () => {
                const fromDate = document.getElementById('rangeFromDate').value;
                const toDate = document.getElementById('rangeToDate').value;
                
                if (fromDate && toDate) {
                    this.setNormalLayout();
                    const fromDisplay = new Date(fromDate).toLocaleDateString();
                    const toDisplay = new Date(toDate).toLocaleDateString();
                    this.updateDisplayedRange(`${fromDisplay} - ${toDisplay}`);
                    
                    await this.loadData('range', fromDate, toDate);
                    dateRangeDropdown.classList.add('hidden');
                }
            });
        }

        // Real Time refresh interval
        const applyRealTime = document.getElementById('applyRealTime');
        const realtimeInterval = document.getElementById('realtimeInterval');

        if (applyRealTime && realtimeInterval) {
            applyRealTime.addEventListener('click', () => {
                const interval = parseInt(realtimeInterval.value);
                if (interval >= 1 && interval <= 60) {
                    this.startRealTimeUpdates(interval * 1000);
                    this.updateDisplayedRange(`Real Time (${interval}s refresh)`);
                    dateRangeDropdown.classList.add('hidden');
                }
            });
        }
    }

    setRealtimeLayout() {
        webLogger.console("setRealtimeLayout implementation called");  // Debug
        const chartsContainer = document.getElementById('chartsContainer');
        const dailyDistributionCard = document.getElementById('dailyDistributionCard');
        
        chartsContainer.style.gridTemplateColumns = "1fr";
        dailyDistributionCard.style.display = "none";
    }

    setNormalLayout() {
        const chartsContainer = document.getElementById('chartsContainer');
        const dailyDistributionCard = document.getElementById('dailyDistributionCard');
        
        chartsContainer.style.gridTemplateColumns = "1fr 1fr";
        dailyDistributionCard.style.display = "block";
    }

    /**
     * Updates the cost trend chart based on time range
     * @param {string} period - Time range period
     * @param {string} fromTime - Start time
     * @param {string} toTime - End time
     */
    async updateCostTrendChart(period, fromTime, toTime) {
        try {
            webLogger.chart('Updating cost trend chart', { period, fromTime, toTime });
            
            const params = new URLSearchParams();
            if (fromTime) params.append('from_time', fromTime);
            if (toTime) params.append('to_time', toTime);
            params.append('type', period);
            
            const response = await fetch(`/api/energy/cost-trend?${params}`);
            const data = await response.json();
            
            if (data && data.success) {
                const options = {
                    xaxis: {
                        type: 'datetime',
                        labels: {
                            datetimeUTC: false,
                            format: this.getTimeFormat(period)
                        }
                    },
                    tooltip: {
                        x: {
                            format: this.getTimeFormat(period)
                        },
                        y: {
                            formatter: (value) => {
                                // Convert cost back to energy for tooltip
                                const energyKWh = value / this.pricePerKwh;
                                return `${this.getCurrencySymbol(this.currency)}${value.toFixed(2)} (${energyKWh.toFixed(2)} kWh)`;
                            }
                        }
                    }
                };

                await this.costTrendChart.updateOptions(options);
                await this.costTrendChart.updateSeries([{
                    name: 'Energy Cost',
                    data: data.series
                }]);
            }
            
            webLogger.chart('Cost trend chart updated successfully');
        } catch (error) {
            webLogger.error('Error updating cost trend chart', error);
        }
    }

    /**
     * Gets the appropriate time format based on period
     * @param {string} period - Time range period
     * @returns {string} Time format string
     */
    getTimeFormat(period) {
        switch(period) {
            case 'realtime':
                return 'HH:mm:ss';
            case 'today':
            case 'day':
                return 'HH:mm';
            case 'range':
                return 'dd MMM';
            default:
                return 'HH:mm';
        }
    }

    calculateCost(row) {
        if (row.ups_realpower_nominal && row.ups_load) {
            const power = (parseFloat(row.ups_realpower_nominal) * parseFloat(row.ups_load)) / 100;
            return (power * this.pricePerKwh) / 1000; // Convert to kWh and multiply by the tariff
        }
        return 0;
    }

    calculateCO2(energy) {
        return energy * this.co2Factor;
    }

    calculateEfficiency(energy) {
        return energy * this.efficiencyFactor;
    }

    async updateUsagePatternChart(period, options = {}) {
        try {
            webLogger.console('=== START updateUsagePatternChart ===');
            webLogger.console('Period:', period);
            webLogger.console('Options:', options);
            
            const params = new URLSearchParams(options);
            params.append('type', period);
            
            webLogger.console('Fetching data with params:', Object.fromEntries(params));
            const response = await fetch(`/api/energy/data?${params}`);
            const data = await response.json();
            webLogger.console('Received data:', data);
            
            if (data && data.cost_distribution) {
                webLogger.console('Cost distribution data:', data.cost_distribution);
                
                // Round all cost values to 3 decimal places
                const costs = [
                    this.roundToDecimals(data.cost_distribution.morning, 3),
                    this.roundToDecimals(data.cost_distribution.afternoon, 3),
                    this.roundToDecimals(data.cost_distribution.evening, 3),
                    this.roundToDecimals(data.cost_distribution.night, 3)
                ];
                
                const labels = [
                    'Morning (6-12)',
                    'Afternoon (12-18)',
                    'Evening (18-23)',
                    'Night (23-6)'
                ];

                if (this.usagePatternChart) {
                    webLogger.console('Updating chart with:', {
                        labels: labels,
                        series: costs
                    });
                    
                    const chartOptions = {
                        labels: labels,
                        plotOptions: {
                            pie: {
                                donut: {
                                    labels: {
                                        value: {
                                            formatter: (val) => {
                                                return this.roundToDecimals(val, 3);
                                            }
                                        },
                                        total: {
                                            formatter: (w) => {
                                                const total = w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                                                return `${this.getCurrencySymbol(this.currency)}${this.roundToDecimals(total, 2)}`;
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        tooltip: {
                            y: {
                                formatter: (val) => {
                                    return `${this.getCurrencySymbol(this.currency)}${this.roundToDecimals(val, 3)}`;
                                }
                            }
                        }
                    };
                    
                    await this.usagePatternChart.updateOptions(chartOptions);
                    await this.usagePatternChart.updateSeries(costs);
                } else {
                    console.warn('usagePatternChart not initialized');
                }
            } else {
                console.warn('No cost_distribution data in response:', data);
            }
            
            webLogger.console('=== END updateUsagePatternChart ===');
        } catch (error) {
            console.error('Error updating usage pattern chart:', error);
        }
    }

    /**
     * Rounds a number to specified decimal places
     * @param {number} value - The number to round
     * @param {number} decimals - Number of decimal places
     * @returns {number} Rounded number
     */
    roundToDecimals(value, decimals = 2) {
        if (typeof value !== 'number') {
            value = parseFloat(value) || 0;
        }
        const multiplier = Math.pow(10, decimals);
        return Math.round(value * multiplier) / multiplier;
    }

    analyzeUsagePatterns(data) {
        // Analyze usage patterns from the data
        // This is an example, you should implement your logic
        return [35, 25, 20, 20];
    }

    analyzeCostDistribution(data) {
        // Analyze the cost distribution from the data
        // This is an example, you should implement your logic
        return [25, 18, 15, 12];
    }

    async updateCharts() {
        try {
            webLogger.console('Starting charts update...');
            
            // Update Cost Trend Chart
            webLogger.console('Updating Cost Trend Chart...');
            await this.updateCostTrendChart();
            
            // Update Usage Pattern Chart
            webLogger.console('Updating Usage Pattern Chart...');
            await this.updateUsagePatternChart();
            
            webLogger.console('All charts updated successfully');
        } catch (error) {
            console.error('Error updating charts:', error);
        }
    }

    async updateEfficiencyAnalytics(period, options = {}) {
        try {
            let params = new URLSearchParams();
            // ... same logic for the parameters ...
            
            const response = await fetch(`/api/energy/data?${params}`);
            const data = await response.json();
            
            if (data) {
                // Create the series using the available data
                const series = [{
                    name: 'Efficiency',
                    data: [
                        data.avgLoad || 0,
                        (data.totalEnergy || 0) * 100,
                        (data.totalCost || 0) * 100
                    ]
                }];
                
                this.efficiencyChart.updateSeries(series);
            }
        } catch (error) {
            console.error('Error updating efficiency analytics:', error);
        }
    }

    updateTrends(trends) {
        if (!trends) return;
        
        // Update the trends in the stat cards
        for (const [type, value] of Object.entries(trends)) {
            const trendElement = document.querySelector(`.stat-trend[data-type="${type}"]`);
            if (trendElement) {
                const icon = trendElement.querySelector('i');
                if (icon) {
                    icon.className = `fas fa-arrow-${value > 0 ? 'up' : 'down'}`;
                }
                trendElement.className = `stat-trend ${value > 0 ? 'positive' : 'negative'}`;
                trendElement.textContent = `${Math.abs(value)}% vs last period`;
            }
        }
    }

    showLoadingState() {
        // Add a div for loading if it doesn't exist
        if (!document.getElementById('loading-overlay')) {
            const overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            overlay.innerHTML = '<div class="loading-spinner">Loading...</div>';
            document.body.appendChild(overlay);
        }
        document.getElementById('loading-overlay').style.display = 'flex';
    }

    hideLoadingState() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    showError(message) {
        // Implement a toast or alert to show the error
        alert(message);
    }

    addLoadingStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #loading-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                display: none;
                justify-content: center;
                align-items: center;
                z-index: 9999;
            }
            .loading-spinner {
                padding: 20px;
                background: white;
                border-radius: 5px;
                box-shadow: 0 0 10px rgba(0,0,0,0.3);
            }
        `;
        document.head.appendChild(style);
    }

    // New functions to handle the different views
    async loadMonthlyView(monthValue) {
        const [year, month] = monthValue.split('-');
        const selectedRange = `${new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' })}`;
        this.updateSelectedRange(selectedRange);
        await this.loadData('month', null, null, { year, month });
    }

    async loadYearlyView() {
        const year = new Date().getFullYear();
        this.updateSelectedRange(`Year ${year}`);
        await this.loadData('year');
    }

    updateSelectedRange(text) {
        const selectedRange = document.querySelector('.selected-range');
        if (selectedRange) {
            selectedRange.textContent = text;
        }
        document.querySelectorAll('.selected-period').forEach(span => {
            span.textContent = text;
        });
    }

    async populateYearPicker() {
        try {
            // Request only the available years from the DB
            const response = await fetch('/api/energy/available-years');
            const years = await response.json();
            
            const yearPicker = document.getElementById('yearPicker');
            yearPicker.innerHTML = '';
            
            years.forEach(year => {
                const option = document.createElement('option');
                option.value = year;
                option.textContent = year;
                yearPicker.appendChild(option);
            });
            
            this.yearsPopulated = true;
        } catch (error) {
            console.error('Error populating year picker:', error);
        }
    }

    async populateMonthPicker() {
        const monthPicker = document.getElementById('monthPicker');
        monthPicker.innerHTML = '';
        
        const months = [];
        const now = new Date();
        
        // Last 12 months
        for (let i = 0; i < 12; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({
                value: `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`,
                label: d.toLocaleString('default', { month: 'long', year: 'numeric' })
            });
        }
        
        months.forEach(month => {
            const option = document.createElement('option');
            option.value = month.value;
            option.textContent = month.label;
            monthPicker.appendChild(option);
        });
        
        this.monthsPopulated = true;
    }

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

    toggleUsagePatternChart(show) {
        const container = document.getElementById('dailyCostDistributionCard');
        if (container) {
            if (show) {
                container.classList.remove('hidden');
            } else {
                container.classList.add('hidden');
            }
        }
    }

    startRealTimeUpdates(interval = 1000) {
        webLogger.console('Starting realtime updates with Chart.js');
        this.isRealTimeMode = true;

        // Hide Daily Cost Distribution chart
        const dailyDistributionCard = document.getElementById('dailyDistributionCard');
        if (dailyDistributionCard) {
            dailyDistributionCard.style.display = 'none';
        }

        // Modify the layout of the grid
        const chartsContainer = document.getElementById('chartsContainer');
        if (chartsContainer) {
            chartsContainer.style.gridTemplateColumns = '1fr';
        }

        // Initialize the realtime chart with Chart.js
        this.initRealtimeCostTrendChart();

        // We no longer need the interval because Chart.js streaming handles the updates
        if (this.realtimeInterval) {
            clearInterval(this.realtimeInterval);
            this.realtimeInterval = null;
        }
    }

    stopRealtimeUpdates() {
        webLogger.console('Stopping realtime updates');
        
        // Reset the mode
        this.isRealTimeMode = false;

        // Show the daily cost distribution card
        const dailyDistributionCard = document.getElementById('dailyDistributionCard');
        if (dailyDistributionCard) {
            dailyDistributionCard.style.display = 'block';
        }

        // Restore the grid layout
        const chartsContainer = document.getElementById('chartsContainer');
        if (chartsContainer) {
            chartsContainer.style.gridTemplateColumns = '1fr 1fr';
        }

        // Destroy the Chart.js chart
        if (this.costTrendChart) {
            this.costTrendChart.destroy();
            this.costTrendChart = null;
        }
        
        // Restore the empty container for ApexCharts
        const container = document.querySelector('#costTrendChart');
        container.innerHTML = '';
        
        // Reinitialize normal charts with ApexCharts
        this.initCharts();
    }

    // NEW: Function to load and render the detail chart in the modal
    async loadDetailChart(timestamp) {
        try {
            webLogger.console('=== START loadDetailChart ===');
            webLogger.console('Input timestamp:', timestamp);

            const clickedDate = new Date(timestamp);
            webLogger.console('Clicked date:', clickedDate);

            const selectedRange = document.querySelector('.range-options a.active');
            const rangeType = selectedRange ? selectedRange.dataset.range : 'today';
            webLogger.console('Range type:', rangeType);

            let fromTime, toTime, detailType;

            if (rangeType === 'range') {
                // If we are in DateRange, show the 24 hours of the clicked day
                fromTime = new Date(clickedDate.setHours(0, 0, 0, 0)).toISOString();
                toTime = new Date(clickedDate.setHours(23, 59, 59, 999)).toISOString();
                detailType = 'day';
            } else {
                // Otherwise show the minutes of the clicked hour
                fromTime = new Date(clickedDate.setHours(clickedDate.getHours(), 0, 0, 0)).toISOString();
                toTime = new Date(clickedDate.setHours(clickedDate.getHours(), 59, 59, 999)).toISOString();
                detailType = 'hour';
            }

            const response = await fetch(`/api/energy/detailed?from_time=${encodeURIComponent(fromTime)}&to_time=${encodeURIComponent(toTime)}&detail_type=${detailType}`);
            const data = await response.json();

            if (data && data.success && data.series) {
                const modalTitle = document.querySelector('.modal_bar-date');
                if (detailType === 'day') {
                    modalTitle.textContent = `Hours detail for ${clickedDate.toLocaleDateString()}`;
                } else {
                    modalTitle.textContent = `Minutes detail for ${clickedDate.getHours()}:00`;
                }

                // Keep track if we are in the minutes modal
                this.isShowingMinutes = detailType === 'hour';

                const detailChartOptions = {
                    chart: {
                        type: 'bar',
                        height: 350,
                        animations: {
                            enabled: true,
                            easing: 'linear',
                            dynamicAnimation: {
                                speed: 1000
                            }
                        },
                        events: {
                            dataPointSelection: async (event, chartContext, config) => {
                                // If we are already in the minutes modal, do nothing
                                if (this.isShowingMinutes) {
                                    return;
                                }

                                // Only for the day modal
                                if (detailType === 'day' && data.series[config.dataPointIndex]) {
                                    const hourData = data.series[config.dataPointIndex];
                                    const hourTimestamp = hourData[0];

                                    const hourDate = new Date(hourTimestamp);
                                    const hourFromTime = new Date(hourDate.setMinutes(0, 0, 0)).toISOString();
                                    const hourToTime = new Date(hourDate.setMinutes(59, 59, 999)).toISOString();

                                    const minuteResponse = await fetch(`/api/energy/detailed?from_time=${encodeURIComponent(hourFromTime)}&to_time=${encodeURIComponent(hourToTime)}&detail_type=hour`);
                                    const minuteData = await minuteResponse.json();

                                    if (minuteData && minuteData.success) {
                                        modalTitle.textContent = `Minutes detail for ${hourDate.getHours()}:00`;
                                        this.isShowingMinutes = true;  // Set the flag

                                        await this.detailChart.updateSeries([{
                                            name: 'Detailed Cost',
                                            data: minuteData.series
                                        }]);
                                    }
                                }
                            }
                        }
                    },
                    plotOptions: {
                        bar: {
                            horizontal: false,
                            columnWidth: '50%',
                            borderRadius: 4
                        }
                    },
                    dataLabels: {
                        enabled: false
                    },
                    xaxis: {
                        type: 'datetime',
                        labels: {
                            datetimeUTC: false,
                            format: 'HH:mm'
                        }
                    },
                    yaxis: {
                        title: {
                            text: 'Detailed Energy Cost'
                        }
                    },
                    tooltip: {
                        x: {
                            format: 'HH:mm'
                        },
                        y: {
                            formatter: (value) => {
                                let watt = this.pricePerKwh > 0 ? (value * 1000 / this.pricePerKwh) : 0;
                                return `${this.getCurrencySymbol(this.currency)}${value.toFixed(2)} ( ${watt.toFixed(1)} W )`;
                            }
                        }
                    },
                    series: [{
                        name: 'Detailed Cost',
                        data: data.series
                    }]
                };

                if (this.detailChart) {
                    await this.detailChart.updateOptions(detailChartOptions);
                    await this.detailChart.updateSeries([{
                        name: 'Detailed Cost',
                        data: data.series
                    }]);
                } else {
                    this.detailChart = new ApexCharts(document.querySelector("#detailChartContainer"), detailChartOptions);
                    this.detailChart.render();
                }
            } else {
                console.error('Detailed data API error', data.error);
                this.showError('Failed to load detailed data');
            }
        } catch (error) {
            console.error('Error loading detailed energy data:', error);
            this.showError('Failed to load detailed data');
        }
    }

    // NEW: Functions to open and close the detail modal
    async showDetailModal(timestamp) {
        const modal = document.getElementById('detailModal');
        const modalDate = modal.querySelector('.modal_bar-date');

        // Use the timestamp directly since ApexCharts already handles the timezone
        const date = new Date(timestamp);

        // Format only the hour for the modal
        const formattedTime = date.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? 
            window.APP_CONFIG.locale : undefined, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: this._timezone
        });

        // Update the data in the modal
        modalDate.textContent = `Consumption detail for ${formattedTime}`;

        // Show the modal
        modal.style.display = 'block';

        // Load the detailed data
        await this.loadDetailChart(timestamp);
    }

    // NEW: Bind the event
    bindModalCloseEvent() {
        const modal = document.getElementById('detailModal');
        if (!modal) {
            console.error('Modal element #detailModal not found');
            return;
        }
        
        const closeBtn = modal.querySelector('.modal_bar-close');
        if (!closeBtn) {
            console.error('Close button .modal_bar-close not found in modal');
            return;
        }

        // Close when clicking on the X
        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        // Close when clicking outside the modal
        window.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });
    }

    initRealtimeCostTrendChart() {
        // Get the canvas for the costTrendChart
        const container = document.querySelector('#costTrendChart');
        if (!container) {
            console.error('Container #costTrendChart not found');
            return;
        }
        
        // If an ApexCharts graph already exists, destroy it
        if (this.costTrendChart && typeof this.costTrendChart.destroy === 'function') {
            this.costTrendChart.destroy();
        }
        
        // Remove the ApexCharts element and create a new canvas
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'realtimeEnergyChart';
        container.appendChild(canvas);
        
        const ctx = canvas.getContext('2d');
        
        // Create a gradient for filling under the line
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(0, 200, 83, 0.3)');
        gradient.addColorStop(1, 'rgba(0, 200, 83, 0.0)');
        
        // Initialize the data buffer
        this.dataBuffer = [];
        this.bufferSize = 15; // As in main_page.js for better smoothing
        
        // Chart.js configuration
        const chartConfig = {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Energy Cost',
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
                        duration: 60000, // Show only 60 seconds
                        refresh: 1000,
                        delay: 1000,
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
                    y: {
                        min: 0, // Set a fixed minimum at 0
                        max: (context) => {
                            if (context.chart.data.datasets[0].data.length > 0) {
                                let maxValue = Math.max(...context.chart.data.datasets[0].data.map(d => d.y));
                                // Ensure a minimum of at least 0.005 to always display the chart
                                return Math.max(0.005, Math.ceil(maxValue * 1.2 * 1000) / 1000);
                            }
                            return 0.005;
                        },
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: '#00c853'
                        },
                        title: {
                            display: true,
                            text: `Cost (${this.getCurrencySymbol(this.currency)})`,
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
        this.costTrendChart = new Chart(ctx, chartConfig);
        
        webLogger.console('Realtime Chart.js initialized for energy cost');
    }

    // New method to update the Chart.js chart in real time
    onChartRefresh(chart) {
        return fetch('/api/ups/cache')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data && Array.isArray(result.data)) {
                    const data = result.data[1];
                    let powerValue = parseFloat(data.ups_realpower || 0);
                    
                    // Make sure the value is never zero or negative
                    powerValue = Math.max(powerValue, 1);
                    
                    // Calculate the real-time cost (kWh * rate)
                    const costValue = (powerValue / 1000) * this.pricePerKwh;
                    
                    const now = Date.now();

                    // Add the new point to the buffer
                    this.dataBuffer.push({
                        x: now,
                        y: costValue
                    });

                    // Keep the buffer at the correct size
                    if (this.dataBuffer.length > this.bufferSize) {
                        this.dataBuffer.shift();
                    }

                    // Calculate the smoothed point using the buffer
                    const smoothedValue = this.calculateSmoothedValue();

                    // Add the smoothed point to the chart
                    chart.data.datasets[0].data.push({
                        x: now,
                        y: smoothedValue
                    });

                    // Update the chart color based on the power value
                    this.updateChartColor(chart, powerValue);

                    // Also update the statistics data
                    const statsData = {
                        totalEnergy: powerValue,
                        avgLoad: parseFloat(data.ups_load || 0),
                        totalCost: costValue,
                        co2: (powerValue / 1000) * this.co2Factor
                    };
                    
                    this.updateStatsCards(statsData);
                    
                    chart.update('quiet');
                }
            })
            .catch(error => console.error('Error fetching power data for chart:', error));
    }

    // Method to calculate the smoothed value
    calculateSmoothedValue() {
        if (this.dataBuffer.length === 0) return 0;
        
        // Use a smoothing algorithm with weights
        const weights = [];
        for (let i = 0; i < this.dataBuffer.length; i++) {
            // Formula to give more weight to recent values
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

    // Method to update the chart color based on the value
    updateChartColor(chart, powerValue) {
        // Change the color based on the power level
        let color;
        if (powerValue > 500) {
            color = '#ef4444'; // Red for high consumption
        } else if (powerValue > 200) {
            color = '#f59e0b'; // Orange for medium consumption
        } else {
            color = '#00c853'; // Green for low consumption
        }
        
        chart.data.datasets[0].borderColor = color;
        
        // Also update the gradient
        const ctx = chart.ctx;
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, this.hexToRgba(color, 0.3));
        gradient.addColorStop(1, this.hexToRgba(color, 0.0));
        chart.data.datasets[0].backgroundColor = gradient;
    }

    // Method to convert a color hex to rgba
    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    async checkHistoricalData() {
        try {
            const now = new Date();
            const currentTime = now.toLocaleTimeString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, { hour: '2-digit', minute: '2-digit' });
            // Call the "today" branch of the API
            const response = await fetch(`/api/energy/data?type=today&from_time=00:00&to_time=${encodeURIComponent(currentTime)}`);
            const data = await response.json();
            webLogger.data('Historical Energy Data:', data);
            
            // Check if historical data is present based on root level statistics
            if (data) {
                const totalEnergy = data.totalEnergy !== undefined ? parseFloat(data.totalEnergy) : 0;
                const avgLoad = data.avgLoad !== undefined ? parseFloat(data.avgLoad) : 0;
                if (totalEnergy > 0 || avgLoad > 0) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            console.error('Error checking historical energy data:', error);
            return false;
        }
    }

    showNotification(message, type = 'info') {
        // Create a notification element with the message and an icon
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `<i class="fas fa-info-circle"></i><span>${message}</span>`;
        document.body.appendChild(notification);
        // Remove the notification after 5 seconds
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    // Added function to listen to realtime data via WebSocket, like in BatteryPage
    initSocketListeners() {
         // Use the same Socket.IO instance if available
         const socket = io();  // Ensure the socket endpoint is configured correctly
         socket.on('energy_update', (data) => {
             webLogger.data('Socket energy_update:', data);
             // Update charts and widgets with the new realtime data
             this.updateCharts(data.history);
             this.updateStats(data.stats);
         });
    }
}

// Initialize EnergyPage once the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    const energyPage = new EnergyPage();
    // Initialize event listeners here
    energyPage.initEventListeners();
}); 