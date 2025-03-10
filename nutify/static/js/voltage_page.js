class VoltagePage extends BasePage {
    constructor() {
        super();
        webLogger.enable(false);
        this.availableMetrics = null;
        this.isRealTimeMode = true;
        this.realTimeInterval = null;
        this.realTimeIntervalDuration = 1000;
        this.isFirstRealTimeUpdate = true;
        this.voltageMetrics = [];
        this.supportedCharts = new Set();
        this.widgetsInitialized = false;
        
        this._timezone = this.getConfiguredTimezone();
        
        (async () => {
            try {
                await this.loadMetrics();
                this.initEventListeners();
                // Initialize the widgets once
                if (!this.widgetsInitialized) {
                    const widgetsContainer = document.getElementById('voltageWidgetsContainer');
                    if (widgetsContainer) {
                        this.renderVoltageWidgets(widgetsContainer);
                        this.widgetsInitialized = true;
                    }
                }
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

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <i class="fas fa-info-circle"></i>
            <span>${message}</span>
        `;
        document.body.appendChild(notification);
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    async initPage() {
        try {
            await this.loadMetrics();
            this.initCharts();
            this.initEventListeners();
            this.updateDisplayedRange('Today (00:00 - 23:59)');
            // Check if there is enough historical data for the Today mode
            const hasEnoughData = await this.checkHistoricalData();
            if (hasEnoughData) {
                await this.loadData('today', '00:00', '23:59');
            } else {
                this.showNotification('Database in phase of population - Real Time mode activated', 'warning');
                // Set the Real Time mode in the menu (removes active from all and adds the realtime one)
                document.querySelectorAll('.range-options a').forEach(option => {
                    option.classList.remove('active');
                    if (option.dataset.range === 'realtime') {
                        option.classList.add('active');
                    }
                });
                this.updateDisplayedRange('Real Time');
                this.startRealTimeUpdates();
            }
            // If necessary, you can continue here with any other updates (e.g. widgets)
            const widgetsContainer = document.getElementById('voltageWidgetsContainer');
            if (widgetsContainer) {
                this.renderVoltageWidgets(widgetsContainer);
            }
            this.hideLoadingState();
        } catch (error) {
            webLogger.error('Error initializing page:', error);
            this.hideLoadingState();
        }
    }

    async loadMetrics() {
        try {
            const [metricsResponse, statusResponse] = await Promise.all([
                fetch('/api/voltage/metrics'),
                fetch('/api/data/ups_status')
            ]);
            
            const metricsData = await metricsResponse.json();
            const statusData = await statusResponse.json();
            
            if (metricsData.success && metricsData.data) {
                const processedMetrics = {};
                for (const [key, value] of Object.entries(metricsData.data)) {
                    if (key === 'input_sensitivity') {
                        processedMetrics[key] = String(value);
                    } else {
                        const numValue = parseFloat(value);
                        processedMetrics[key] = isNaN(numValue) ? '0.0' : numValue;
                    }
                }
                
                if (statusData.success && statusData.data) {
                    processedMetrics['ups_status'] = statusData.data.ups_status;
                }
                
                this.availableMetrics = processedMetrics;
                // Populate voltageMetrics with the available numeric metrics
                this.voltageMetrics = Object.keys(processedMetrics).filter(key => 
                    typeof processedMetrics[key] === 'number' && 
                    key !== 'ups_status'
                );
                webLogger.data('Available voltage metrics:', this.voltageMetrics);
                
                // Determine which charts are supported
                this.determineSupportedCharts();
            }
        } catch (error) {
            webLogger.error('Error loading metrics:', error);
            this.availableMetrics = {};
            this.voltageMetrics = [];
        }
    }

    // New method to determine which charts are supported
    determineSupportedCharts() {
        webLogger.data("Available metrics:", this.availableMetrics);
        
        // Voltage Chart
        if (this.availableMetrics['input_voltage'] || this.availableMetrics['output_voltage']) {
            this.supportedCharts.add('voltage');
            webLogger.data("Voltage chart supported");
        }
        
        // Voltage Nominal Chart
        if (this.availableMetrics['input_voltage_nominal'] || this.availableMetrics['output_voltage_nominal']) {
            this.supportedCharts.add('voltageNominal');
            webLogger.data("Voltage Nominal chart supported");
        }
        
        // Transfer Chart
        if (this.availableMetrics['input_transfer_low'] || this.availableMetrics['input_transfer_high']) {
            this.supportedCharts.add('transfer');
            webLogger.data("Transfer chart supported");
        }
        
        // Current Chart
        if (this.availableMetrics['input_current'] || this.availableMetrics['output_current']) {
            this.supportedCharts.add('current');
            webLogger.data("Current chart supported");
        }
        
        // Frequency Chart
        if (this.availableMetrics['input_frequency'] || this.availableMetrics['output_frequency']) {
            this.supportedCharts.add('frequency');
            webLogger.data("Frequency chart supported");
        }
        
        webLogger.data("Supported charts:", Array.from(this.supportedCharts));
    }

    // Modify initCharts to initialize only the supported charts
    initCharts() {
        webLogger.page('Initializing voltage charts');
        
        // First make all containers visible
        this.showCharts();
        
        // Voltage Monitor Chart (main chart with all voltages)
        if (this.supportedCharts.has('voltage')) {
            const voltageChartElement = document.getElementById('voltageChart');
            if (voltageChartElement) {
                webLogger.data('Initializing voltage monitor chart');
                
                // Determine which voltage metrics are available for this UPS
                const availableVoltageMetrics = [];
                const voltageColors = [];
                const strokeWidths = [];
                const dashArrays = [];
                
                // Check for input_voltage
                if (this.availableMetrics.hasOwnProperty('input_voltage') && 
                    this.availableMetrics.input_voltage !== undefined && 
                    this.availableMetrics.input_voltage !== null) {
                    availableVoltageMetrics.push('INPUT VOLTAGE');
                    voltageColors.push('#2E93fA');
                    strokeWidths.push(2);
                    dashArrays.push(0);
                }
                
                // Check for output_voltage
                if (this.availableMetrics.hasOwnProperty('output_voltage') && 
                    this.availableMetrics.output_voltage !== undefined && 
                    this.availableMetrics.output_voltage !== null) {
                    availableVoltageMetrics.push('OUTPUT VOLTAGE');
                    voltageColors.push('#66DA26');
                    strokeWidths.push(2);
                    dashArrays.push(0);
                }
                
                // Check for input_voltage_nominal
                if (this.availableMetrics.hasOwnProperty('input_voltage_nominal') && 
                    this.availableMetrics.input_voltage_nominal !== undefined && 
                    this.availableMetrics.input_voltage_nominal !== null) {
                    availableVoltageMetrics.push('INPUT NOMINAL');
                    voltageColors.push('#546E7A');
                    strokeWidths.push(1);
                    dashArrays.push(5);
                }
                
                // Check for output_voltage_nominal
                if (this.availableMetrics.hasOwnProperty('output_voltage_nominal') && 
                    this.availableMetrics.output_voltage_nominal !== undefined && 
                    this.availableMetrics.output_voltage_nominal !== null) {
                    availableVoltageMetrics.push('OUTPUT NOMINAL');
                    voltageColors.push('#546E7A');
                    strokeWidths.push(1);
                    dashArrays.push(5);
                }
                
                webLogger.data('Available voltage metrics for chart:', availableVoltageMetrics);
                
                // Initialize empty series for each available metric
                const emptySeries = availableVoltageMetrics.map(name => ({
                    name: name,
                    data: []
                }));
                
                this.voltageChart = new ApexCharts(voltageChartElement, {
                    series: emptySeries,
                    chart: {
                        type: 'line',
                        height: 350,
                        animations: {
                            enabled: true,
                            easing: 'linear',
                            dynamicAnimation: { speed: 1000 }
                        }
                    },
                    stroke: {
                        curve: 'smooth',
                        width: strokeWidths,
                        dashArray: dashArrays
                    },
                    colors: voltageColors,
                    legend: {
                        show: true,
                        position: 'top'
                    },
                    xaxis: {
                        type: 'datetime',
                        labels: { datetimeUTC: false }
                    },
                    yaxis: {
                        labels: {
                            formatter: (val) => val.toFixed(1) + "V"
                        }
                    }
                });
                this.voltageChart.render();
            }
        }

        // Transfer Thresholds Chart (chart of limits)
        if (this.supportedCharts.has('transfer')) {
            const transferChartElement = document.getElementById('transferChart');
            if (transferChartElement) {
                webLogger.data('Initializing transfer thresholds chart');
                this.transferChart = new ApexCharts(transferChartElement, {
                    series: [],
                    chart: {
                        type: 'line',
                        height: 350,
                        animations: {
                            enabled: true,
                            easing: 'linear',
                            dynamicAnimation: { speed: 1000 }
                        }
                    },
                    stroke: {
                        curve: 'smooth',
                        width: [2, 2, 1],  // Different thicknesses for the lines
                        dashArray: [0, 0, 5]  // Dashed line for the nominal
                    },
                    colors: ['#FF4560', '#FF4560', '#546E7A'],  // Red for the limits, gray for nominal
                    legend: {
                        show: true,
                        position: 'top'
                    },
                    xaxis: {
                        type: 'datetime',
                        labels: { datetimeUTC: false }
                    },
                    yaxis: {
                        labels: {
                            formatter: (val) => val.toFixed(1) + "V"
                        }
                    }
                });
                this.transferChart.render();
            }
        }
    }

    /**
     * Initialize the chart for Input/Output Voltage
     */
    initVoltageChart() {
        const el = document.querySelector("#voltageChart");
        webLogger.data("Voltage chart container:", el);
        if (!el) return;

        const group = ['input_voltage', 'output_voltage'];
        const series = [];
        group.forEach(metric => {
            if (this.availableMetrics && this.availableMetrics[metric] !== undefined) {
                series.push({
                    name: metric.replace(/_/g, ' ').toUpperCase(),
                    data: []
                });
            }
        });
        webLogger.data("Initial voltage series:", series);

        if (series.length > 0) {
            el.classList.remove("hidden");
            el.style.removeProperty('display');
            webLogger.data("Creating voltage chart with options:", {
                series,
                height: 350,
                type: 'line'
            });
            this.voltageChart = new ApexCharts(el, {
                series: series,
                chart: {
                    type: 'line',
                    height: 350,
                    animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 1000 } }
                },
                stroke: {
                    curve: 'smooth',
                    width: 2
                },
                xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
                yaxis: { title: { text: 'Voltage (V)' }, decimalsInFloat: 1 },
                tooltip: { shared: true, x: { format: 'dd MMM yyyy HH:mm:ss' } }
            });
            this.voltageChart.render();
            webLogger.data("Voltage chart rendered");
        } else {
            el.style.display = "none";
            webLogger.data("No series available for voltage chart");
        }
    }
    
    /**
     * Initialize the chart for Input/Output Voltage_nominal
     */
    initVoltageNominalChart() {
        const el = document.querySelector("#voltageNominalChart");
        webLogger.data("Voltage Nominal chart container:", el);
        if (!el) return;

        const group = ['input_voltage_nominal', 'output_voltage_nominal'];
        const series = [];
        group.forEach(metric => {
            if (this.availableMetrics && this.availableMetrics[metric] !== undefined) {
                series.push({
                    name: metric.replace(/_/g, ' ').toUpperCase(),
                    data: []
                });
            }
        });
        webLogger.data("Initial voltage nominal series:", series);

        if (series.length > 0) {
            el.classList.remove("hidden");
            el.style.removeProperty('display');
            webLogger.data("Creating voltage nominal chart with options:", {
                series,
                height: 350,
                type: 'line'
            });
            this.voltageNominalChart = new ApexCharts(el, {
                series: series,
                chart: { type: 'line', height: 350, animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 1000 } } },
                stroke: {
                    curve: 'smooth',
                    width: 2
                },
                xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
                yaxis: { title: { text: 'Voltage Nominal (V)' }, decimalsInFloat: 1 },
                tooltip: { shared: true, x: { format: 'dd MMM yyyy HH:mm:ss' } }
            });
            this.voltageNominalChart.render();
            webLogger.data("Voltage nominal chart rendered");
        } else {
            el.style.display = "none";
            webLogger.data("No series available for voltage nominal chart");
        }
    }
    
    /**
     * Initialize the chart for Input_TRANSFER_LOW and INPUT_TRANSFER_HIGH
     */
    initTransferChart() {
        const el = document.querySelector("#transferChart");
        webLogger.data("Transfer chart container:", el);
        if (!el) return;

        const group = ['input_transfer_low', 'input_transfer_high'];
        const series = [];
        group.forEach(metric => {
            if (this.availableMetrics && this.availableMetrics[metric] !== undefined) {
                series.push({
                    name: metric.replace(/_/g, ' ').toUpperCase(),
                    data: []
                });
            }
        });
        webLogger.data("Initial transfer series:", series);

        if (series.length > 0) {
            el.classList.remove("hidden");
            el.style.removeProperty('display');
            webLogger.data("Creating transfer chart with options:", {
                series,
                height: 350,
                type: 'line'
            });
            this.transferChart = new ApexCharts(el, {
                series: series,
                chart: { type: 'line', height: 350, animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 1000 } } },
                stroke: {
                    curve: 'smooth',
                    width: 2
                },
                xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
                yaxis: { title: { text: 'Transfer (V)' }, decimalsInFloat: 1 },
                tooltip: { shared: true, x: { format: 'dd MMM yyyy HH:mm:ss' } }
            });
            this.transferChart.render();
            webLogger.data("Transfer chart rendered");
        } else {
            el.style.display = "none";
            el.style.removeProperty('display');
            webLogger.data("No series available for transfer chart");
        }
    }
    
    /**
     * Initialize the chart for Input/Output Current
     */
    initCurrentChart() {
        const el = document.querySelector("#currentChart");
        if (!el) return;
        const group = ['input_current', 'output_current'];
        const series = [];
        group.forEach(metric => {
            if (this.availableMetrics && this.availableMetrics[metric] !== undefined) {
                series.push({
                    name: metric.replace(/_/g, ' ').toUpperCase(),
                    data: []
                });
            }
        });
        if (series.length > 0) {
            this.currentChart = new ApexCharts(el, {
                series: series,
                chart: { type: 'line', height: 350, animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 1000 } } },
                xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
                yaxis: { title: { text: 'Current (A)' }, decimalsInFloat: 1 },
                tooltip: { shared: true, x: { format: 'dd MMM yyyy HH:mm:ss' } }
            });
            this.currentChart.render();
        }
    }
    
    /**
     * Initialize the chart for Input/Output Frequency
     */
    initFrequencyChart() {
        const el = document.querySelector("#frequencyChart");
        if (!el) return;

        const group = ['input_frequency', 'output_frequency'];
        const series = [];
        group.forEach(metric => {
            if (this.availableMetrics && this.availableMetrics[metric] !== undefined) {
                series.push({
                    name: metric.replace(/_/g, ' ').toUpperCase(),
                    data: []
                });
            }
        });

        if (series.length > 0) {
            // Remove the hidden class (the container will be visible)
            el.classList.remove("hidden");
            el.style.removeProperty('display');
            this.frequencyChart = new ApexCharts(el, {
                series: series,
                chart: {
                    type: 'line',
                    height: 350,
                    animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: 1000 } }
                },
                xaxis: { type: 'datetime', labels: { datetimeUTC: false } },
                yaxis: { title: { text: 'Frequency (Hz)' }, decimalsInFloat: 1 },
                tooltip: { shared: true, x: { format: 'dd MMM yyyy HH:mm:ss' } }
            });
            this.frequencyChart.render();
        } else {
            // In the absence of data, ensure the container remains hidden
            el.style.display = "none";
        }
    }

    initCombinedChart() {
        const metrics = this.availableMetrics || {};
        const series = [];
        const colors = [
            '#2E93fA', '#66DA26', '#FF9800', '#E91E63', 
            '#546E7A', '#00E396', '#FEB019', '#4B0082'
        ];
        
        // Add a series for each available metric
        let colorIndex = 0;
        for (const [key, value] of Object.entries(metrics)) {
            // Exclude non-numeric or irrelevant metrics
            if (key === 'ups_status' || key === 'input_sensitivity') continue;
            
            series.push({
                name: key.replace(/_/g, ' ').toUpperCase(),
                data: [],
                color: colors[colorIndex % colors.length],
                type: 'line'
            });
            colorIndex++;
        }

        const options = {
            series: series,
            chart: {
                type: 'line',
                height: 450,
                animations: {
                    enabled: true,
                    easing: 'linear',
                    dynamicAnimation: {
                        speed: 1000
                    }
                }
            },
            stroke: {
                curve: 'smooth',
                width: 2
            },
            xaxis: {
                type: 'datetime'
            },
            yaxis: {
                title: {
                    text: 'Value'
                },
                labels: {
                    formatter: function(val) {
                        return val.toFixed(1);
                    }
                }
            },
            tooltip: {
                shared: true,
                intersect: false,
                x: {
                    format: 'dd MMM yyyy HH:mm:ss'
                }
            },
            legend: {
                position: 'top',
                horizontalAlign: 'center'
            }
        };

        this.combinedChart = new ApexCharts(
            document.querySelector("#combinedVoltageChart"), 
            options
        );
        this.combinedChart.render();
    }

    initFrequencyChart(element) {
        const options = {
            series: [
                {
                    name: 'Input Frequency',
                    data: [],
                    color: '#2E93fA'
                },
                {
                    name: 'Output Frequency',
                    data: [],
                    color: '#66DA26'
                }
            ],
            chart: {
                type: 'line',
                height: 350,
                animations: {
                    enabled: true,
                    easing: 'linear',
                    dynamicAnimation: {
                        speed: 1000
                    }
                }
            },
            stroke: {
                curve: 'smooth',
                width: 2
            },
            xaxis: {
                type: 'datetime'
            },
            yaxis: {
                title: {
                    text: 'Frequency (Hz)'
                }
            },
            tooltip: {
                x: {
                    format: 'dd MMM yyyy HH:mm:ss'
                }
            }
        };

        this.frequencyChart = new ApexCharts(element, options);
        this.frequencyChart.render();
    }

    setupRealTimeUpdates() {
        const socket = io();
        
        socket.on('voltage_update', (data) => {
            if (this.isRealTimeMode) {
                this.updateChartsRealTime(data);
                this.updateStats(data);
            }
        });
    }

    async loadData(period = 'day', fromTime = null, toTime = null, selectedDay = null) {
        try {
            this.showLoadingState();
            webLogger.data('Loading data with params:', { period, fromTime, toTime, selectedDay });
            
            const params = new URLSearchParams();
            params.append('period', period);

            switch (period) {
                case 'today':
                    if (fromTime) params.append('from_time', fromTime);
                    if (toTime) params.append('to_time', toTime);
                    break;
                    
                case 'day':
                    if (selectedDay) {
                        params.append('selected_day', selectedDay);
                        params.append('from_time', '00:00');
                        params.append('to_time', '23:59');
                    }
                    break;
                    
                case 'range':
                    if (fromTime) params.append('from_time', fromTime);
                    if (toTime) params.append('to_time', toTime);
                    break;
            }

            webLogger.data('Request params:', Object.fromEntries(params));
            
            const response = await fetch(`/api/voltage/history?${params.toString()}`);
            const data = await response.json();
            
            webLogger.data('Historical data received:', data);

            if (!data.success || !data.data) {
                throw new Error('Failed to load voltage data');
            }

            // Update the charts with the new data
            await this.updateChartsWithHistoricalData(data.data);

            this.hideLoadingState();
        } catch (error) {
            webLogger.error('Error loading voltage data:', error);
            this.hideLoadingState();
            this.showError('Error loading voltage data');
        }
    }

    // New method to update the charts with historical data
    async updateChartsWithHistoricalData(data) {
        // Voltage Monitor Chart (main chart)
        if (this.voltageChart && this.supportedCharts.has('voltage')) {
            const voltageSeries = [];
            
            // Add series only if data exists
            if (data.input_voltage && data.input_voltage.length > 0) {
                voltageSeries.push({
                    name: 'INPUT VOLTAGE',
                    data: data.input_voltage.map(point => ({
                        x: new Date(point.timestamp).getTime(),
                        y: parseFloat(point.value)
                    }))
                });
            }

            if (data.output_voltage && data.output_voltage.length > 0) {
                voltageSeries.push({
                    name: 'OUTPUT VOLTAGE',
                    data: data.output_voltage.map(point => ({
                        x: new Date(point.timestamp).getTime(),
                        y: parseFloat(point.value)
                    }))
                });
            }

            if (data.input_voltage_nominal && data.input_voltage_nominal.length > 0) {
                voltageSeries.push({
                    name: 'INPUT NOMINAL',
                    data: data.input_voltage_nominal.map(point => ({
                        x: new Date(point.timestamp).getTime(),
                        y: parseFloat(point.value)
                    }))
                });
            }

            if (data.output_voltage_nominal && data.output_voltage_nominal.length > 0) {
                voltageSeries.push({
                    name: 'OUTPUT NOMINAL',
                    data: data.output_voltage_nominal.map(point => ({
                        x: new Date(point.timestamp).getTime(),
                        y: parseFloat(point.value)
                    }))
                });
            }

            webLogger.data('Updating voltage chart with series:', voltageSeries);
            await this.voltageChart.updateSeries(voltageSeries);
        }

        // Transfer Chart (chart of limits)
        if (this.transferChart && this.supportedCharts.has('transfer')) {
            const transferSeries = [];
            
            // INPUT TRANSFER LOW
            if (data.input_transfer_low && data.input_transfer_low.length > 0) {
                transferSeries.push({
                    name: 'INPUT TRANSFER LOW',
                    data: data.input_transfer_low.map(point => ({
                        x: new Date(point.timestamp).getTime(),
                        y: parseFloat(point.value)
                    }))
                });
            }

            // INPUT TRANSFER HIGH
            if (data.input_transfer_high && data.input_transfer_high.length > 0) {
                transferSeries.push({
                    name: 'INPUT TRANSFER HIGH',
                    data: data.input_transfer_high.map(point => ({
                        x: new Date(point.timestamp).getTime(),
                        y: parseFloat(point.value)
                    }))
                });
            }

            // VOLTAGE NOMINAL as a reference
            if (data.input_voltage_nominal && data.input_voltage_nominal.length > 0) {
                transferSeries.push({
                    name: 'NOMINAL REFERENCE',
                    data: data.input_voltage_nominal.map(point => ({
                        x: new Date(point.timestamp).getTime(),
                        y: parseFloat(point.value)
                    }))
                });
            }

            webLogger.data('Updating transfer chart with series:', transferSeries);
            await this.transferChart.updateSeries(transferSeries);
        }
    }

    async updateCharts(data) {
        webLogger.page('Updating charts with data');
        
        if (this.combinedChart) {
            const voltageData = {
                input: [],
                output: [],
                inputCurrent: [],
                outputCurrent: []
            };

            if (data.input_voltage) {
                voltageData.input = data.input_voltage.map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: parseFloat(point.value)
                }));
            }
            if (data.output_voltage) {
                voltageData.output = data.output_voltage.map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: parseFloat(point.value)
                }));
            }
            if (data.input_current) {
                voltageData.inputCurrent = data.input_current.map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: parseFloat(point.value)
                }));
            }
            if (data.output_current) {
                voltageData.outputCurrent = data.output_current.map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: parseFloat(point.value)
                }));
            }

            await this.combinedChart.updateSeries([
                { name: 'Input Voltage', data: voltageData.input },
                { name: 'Output Voltage', data: voltageData.output },
                { name: 'Input Current', data: voltageData.inputCurrent },
                { name: 'Output Current', data: voltageData.outputCurrent }
            ]);
        }

        if (this.frequencyChart && (data.input_frequency || data.output_frequency)) {
            const freqData = {
                input: data.input_frequency ? data.input_frequency.map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: parseFloat(point.value)
                })) : [],
                output: data.output_frequency ? data.output_frequency.map(point => ({
                    x: new Date(point.timestamp).getTime(),
                    y: parseFloat(point.value)
                })) : []
            };

            await this.frequencyChart.updateSeries([
                { name: 'Input Frequency', data: freqData.input },
                { name: 'Output Frequency', data: freqData.output }
            ]);
        }

        if (this.qualityChart && data.voltage_quality) {
            const qualityData = data.voltage_quality.map(point => ({
                x: new Date(point.timestamp).getTime(),
                y: parseFloat(point.value)
            }));

            await this.qualityChart.updateSeries([
                { name: 'Voltage Quality', data: qualityData }
            ]);
        }
    }

    updateChartsRealTime(data) {
        if (this.combinedChart) {
            const newTime = new Date().getTime();
            const inputVoltage = (data.input_voltage !== undefined) ? data.input_voltage : 0;
            const outputVoltage = (data.output_voltage !== undefined) ? data.output_voltage : 0;
            const inputCurrent = (data.input_current !== undefined) ? data.input_current : 0;
            const outputCurrent = (data.output_current !== undefined) ? data.output_current : 0;
            webLogger.console('Updating combinedChart at time:', newTime);

            // Retrieve the current data of the series
            let s0 = this.combinedChart.w.config.series[0].data || [];
            let s1 = this.combinedChart.w.config.series[1].data || [];
            let s2 = this.combinedChart.w.config.series[2].data || [];
            let s3 = this.combinedChart.w.config.series[3].data || [];

            // If the series is empty, insert a small initial point in the past
            if (s0.length === 0) {
                s0 = [{ x: newTime - 1000, y: inputVoltage }, { x: newTime, y: inputVoltage }];
                s1 = [{ x: newTime - 1000, y: outputVoltage }, { x: newTime, y: outputVoltage }];
                s2 = [{ x: newTime - 1000, y: inputCurrent }, { x: newTime, y: inputCurrent }];
                s3 = [{ x: newTime - 1000, y: outputCurrent }, { x: newTime, y: outputCurrent }];
            } else {
                s0.push({ x: newTime, y: inputVoltage });
                s1.push({ x: newTime, y: outputVoltage });
                s2.push({ x: newTime, y: inputCurrent });
                s3.push({ x: newTime, y: outputCurrent });
            }

            this.combinedChart.updateSeries([
                { data: s0 },
                { data: s1 },
                { data: s2 },
                { data: s3 }
            ]);
        } else {
            console.error('Combined chart not initialized');
        }
    }

    updateStats(stats) {
        document.querySelectorAll('.stat-value').forEach(element => {
            const type = element.dataset.type;
            if (!type || stats[type] === undefined || stats[type] === null) return;
            
            try {
                let displayValue;
                if (type === 'input_sensitivity') {
                    displayValue = stats[type];
                } else {
                    const value = parseFloat(stats[type].current || stats[type].value || stats[type] || 0);
                    displayValue = isNaN(value) ? '0.0' : value.toFixed(1);
                    
                    switch(type) {
                        case 'input_voltage':
                        case 'output_voltage':
                        case 'input_voltage_nominal':
                        case 'output_voltage_nominal':
                        case 'input_transfer_low':
                        case 'input_transfer_high':
                            displayValue += 'V';
                            break;
                        case 'input_current':
                        case 'output_current':
                            displayValue += 'A';
                            break;
                        case 'input_frequency':
                        case 'output_frequency':
                            displayValue += 'Hz';
                            break;
                    }
                }
                element.textContent = displayValue;
            } catch (error) {
                logger.error(`Error updating stat ${type}`);
                element.textContent = '0.0';
            }
        });
    }

    renderVoltageWidgets(element) {
        if (!element || !this.availableMetrics) return;

        // List of metrics to show in the widgets (remove ups_status and ups_load)
        const allowedMetrics = [
            'input_voltage',
            'output_voltage',
            'input_voltage_nominal',
            'output_voltage_nominal',
            'input_transfer_low',
            'input_transfer_high',
            'input_frequency',
            'output_frequency',
            'input_sensitivity'
        ];

        const voltageVariables = [];
        
        // Filter and format only the allowed metrics
        for (const [key, value] of Object.entries(this.availableMetrics)) {
            if (!allowedMetrics.includes(key)) continue;

            let unit = '';
            let icon = 'fa-chart-line';
            
            if (key.includes('voltage')) {
                unit = 'V';
                icon = 'fa-bolt';
            } else if (key.includes('current')) {
                unit = 'A';
                icon = 'fa-wave-square';
            } else if (key.includes('frequency')) {
                unit = 'Hz';
                icon = 'fa-tachometer-alt';
            } else if (key.includes('transfer')) {
                unit = 'V';
                icon = 'fa-exchange-alt';
            } else if (key.includes('sensitivity')) {
                icon = 'fa-sliders-h';
            }

            // Format the value
            let displayValue;
            if (key === 'input_sensitivity') {
                displayValue = value;
            } else {
                displayValue = typeof value === 'number' ? 
                              value.toFixed(1) + unit : 
                              value + unit;
            }

            // Format the label
            const label = key
                .replace(/_/g, ' ')
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');

            voltageVariables.push({
                name: key,
                value: displayValue,
                icon: icon,
                label: label
            });
        }

        // Generate the HTML for the normal widgets instead of mini
        const widgetsHtml = voltageVariables.map(variable => `
            <div class="stat_card">
                <div class="stat-icon">
                    <i class="fas ${variable.icon}"></i>
                </div>
                <div class="stat-content">
                    <div class="stat-header">
                        <span class="stat-label">${variable.label}</span>
                        <span class="selected-period">Now</span>
                    </div>
                    <span class="stat-value" data-type="${variable.name}">${variable.value}</span>
                </div>
                <div class="background-chart" id="${variable.name}BackgroundChart"></div>
            </div>
        `).join('');

        element.innerHTML = widgetsHtml;
    }

    async initEventListeners() {
        webLogger.page('Initializing event listeners');

        // --- Dropdown menu management ---
        const dateRangeBtn = document.getElementById('dateRangeBtn');
        const dateRangeDropdown = document.getElementById('dateRangeDropdown');
        
        if (dateRangeBtn) {
            dateRangeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                dateRangeDropdown.classList.toggle('hidden');
            });
        }

        // Close the dropdown if clicked outside
        document.addEventListener('click', (e) => {
            if (!dateRangeBtn?.contains(e.target) && !dateRangeDropdown?.contains(e.target)) {
                dateRangeDropdown?.classList.add('hidden');
            }
        });

        // --- Range options management ---
        document.querySelectorAll('.range-options a').forEach(option => {
            option.addEventListener('click', (e) => {
                e.preventDefault();
                const range = e.target.dataset.range;
                
                // Remove active from all options
                document.querySelectorAll('.range-options a').forEach(opt => {
                    opt.classList.remove('active');
                });
                // Add active to the selected option
                e.target.classList.add('active');

                // Hide all panels of the menu
                document.querySelectorAll('.time-range-selector, .day-selector, .range-selector, .realtime-selector').forEach(selector => {
                    selector.classList.add('hidden');
                });

                switch (range) {
                    case 'realtime':
                        document.getElementById('realtimeSelectorPanel')?.classList.remove('hidden');
                        this.startRealTimeMode();
                        break;
                    case 'today':
                        const now = new Date();
                        const currentTime = now.toLocaleTimeString(
                            window.APP_CONFIG && window.APP_CONFIG.locale ? 
                            window.APP_CONFIG.locale : undefined, 
                            { hour: '2-digit', minute: '2-digit' }
                        );
                        this.stopRealTimeUpdates();
                        this.updateDisplayedRange(`Today (00:00 - ${currentTime})`);
                        this.loadData('today', '00:00', currentTime);
                        break;
                    case 'day':
                        document.getElementById('daySelectorPanel')?.classList.remove('hidden');
                        break;
                    case 'range':
                        document.getElementById('rangeSelectorPanel')?.classList.remove('hidden');
                        break;
                }
            });
        });

        // --- Apply buttons management ---
        const applyRealTime = document.getElementById('applyRealTime');
        if (applyRealTime) {
            applyRealTime.addEventListener('click', () => {
                const intervalInput = document.getElementById('realtimeInterval');
                const newInterval = parseInt(intervalInput.value);
                if (!isNaN(newInterval) && newInterval > 0) {
                    this.realTimeIntervalDuration = newInterval * 1000;
                    this.startRealTimeUpdates();
                    this.updateDisplayedRange(`Real Time (every ${newInterval}s)`);
                    dateRangeDropdown?.classList.add('hidden');
                }
            });
        }

        const applyDay = document.getElementById('applyDay');
        if (applyDay) {
            applyDay.addEventListener('click', () => {
                const dayPicker = document.getElementById('dayPicker');
                if (dayPicker && dayPicker.value) {
                    this.stopRealTimeUpdates();
                    this.updateDisplayedRange(`Selected Day: ${dayPicker.value}`);
                    this.loadData('day', null, null, dayPicker.value);
                    dateRangeDropdown?.classList.add('hidden');
                }
            });
        }

        const applyRange = document.getElementById('applyRange');
        if (applyRange) {
            applyRange.addEventListener('click', async () => {
                const fromDate = document.getElementById('rangeFromDate');
                const toDate = document.getElementById('rangeToDate');
                if (fromDate && toDate && fromDate.value && toDate.value) {
                    this.stopRealTimeUpdates();
                    
                    // Reset and reinitialize the charts before loading new data
                    this.resetCharts();
                    this.initCharts();
                    
                    // Format the dates in the correct format (YYYY-MM-DD)
                    const fromDateStr = fromDate.value;
                    const toDateStr = toDate.value;
                    
                    this.updateDisplayedRange(`Range: ${fromDateStr} - ${toDateStr}`);
                    await this.loadData('range', fromDateStr, toDateStr);
                    dateRangeDropdown?.classList.add('hidden');
                    
                    // Log for debugging
                    webLogger.data('Loading date range:', {
                        from: fromDateStr,
                        to: toDateStr
                    });
                }
            });
        }
    }

    showLoadingState() {
        const container = document.querySelector('.voltage_page');
        if (container) {
            container.classList.add('loading');
            const loader = document.createElement('div');
            loader.className = 'page-loader';
            loader.innerHTML = '<div class="loader"></div>';
            container.appendChild(loader);
        }
    }

    hideLoadingState() {
        const container = document.querySelector('.voltage_page');
        if (container) {
            container.classList.remove('loading');
            const loader = container.querySelector('.page-loader');
            if (loader) {
                loader.remove();
            }
        }
    }

    updateDisplayedRange(text) {
        const rangeSpan = document.querySelector('.selected-range');
        if (rangeSpan) {
            rangeSpan.textContent = text;
        }
    }

    showError(message) {
        console.error(message);
    }

    startRealTimeUpdates() {
        // Now this method is just a wrapper that calls startRealTimeMode
        // to maintain compatibility with the parts of the code that call it
        this.startRealTimeMode();
    }

    stopRealTimeUpdates() {
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }
        
        // Reset the mode
        this.isRealTimeMode = false;
        
        // Destroy Chart.js charts if they exist
        if (this.voltageChart && this.voltageChart.destroy) {
            this.voltageChart.destroy();
            this.voltageChart = null;
        }
        
        if (this.transferChart && this.transferChart.destroy) {
            this.transferChart.destroy();
            this.transferChart = null;
        }
        
        // Clear the containers
        const voltageContainer = document.querySelector('#voltageChart');
        if (voltageContainer) voltageContainer.innerHTML = '';
        
        const transferContainer = document.querySelector('#transferChart');
        if (transferContainer) transferContainer.innerHTML = '';
        
        // Reinitialize the charts with ApexCharts
        this.initCharts();
    }

    startRealTimeMode() {
        webLogger.console('Starting realtime mode with Chart.js');
        this.isRealTimeMode = true;
        
        // Stop any previous intervals
        if (this.realTimeInterval) {
            clearInterval(this.realTimeInterval);
            this.realTimeInterval = null;
        }
        
        // Reset and initialize charts with Chart.js
        this.initializeRealtimeCharts();
        
        // Update the user interface
        document.querySelectorAll('.chart-container').forEach(container => {
            container.classList.remove('hidden');
        });
        
        // Set realtime mode in the UI
        this.updateDisplayedRange('Real Time');
    }

    initializeRealtimeCharts() {
        // Initialize realtime voltage and transfer charts with Chart.js
        this.initializeRealtimeVoltageChart();
        this.initializeRealtimeTransferChart();
    }

    initializeRealtimeVoltageChart() {
        // Get the chart container
        const container = document.querySelector('#voltageChart');
        if (!container) {
            console.error('Container #voltageChart not found');
            return;
        }
        
        // If an ApexCharts chart already exists, destroy it
        if (this.voltageChart && typeof this.voltageChart.destroy === 'function') {
            this.voltageChart.destroy();
        }
        
        // Remove the ApexCharts element and create a new canvas
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'realtimeVoltageChart';
        container.appendChild(canvas);
        
        const ctx = canvas.getContext('2d');
        
        // Determine which voltage metrics are available for this UPS
        const hasInputVoltage = this.availableMetrics.hasOwnProperty('input_voltage') && 
                                this.availableMetrics.input_voltage !== undefined && 
                                this.availableMetrics.input_voltage !== null;
        
        const hasOutputVoltage = this.availableMetrics.hasOwnProperty('output_voltage') && 
                                 this.availableMetrics.output_voltage !== undefined && 
                                 this.availableMetrics.output_voltage !== null;
        
        webLogger.data('Realtime available metrics - Input voltage:', hasInputVoltage, 'Output voltage:', hasOutputVoltage);
        
        // Initialize the data buffer
        this.voltageDataBuffer = [];
        this.bufferSize = 15; // As in main_page.js for better smoothing
        
        // Create datasets only for available metrics
        const datasets = [];
        
        if (hasInputVoltage) {
            // Create a gradient for filling under the input line
            const inputGradient = ctx.createLinearGradient(0, 0, 0, 300);
            inputGradient.addColorStop(0, 'rgba(46, 147, 250, 0.3)');
            inputGradient.addColorStop(1, 'rgba(46, 147, 250, 0.0)');
            
            datasets.push({
                label: 'Input Voltage',
                backgroundColor: inputGradient,
                borderColor: '#2E93fA',
                borderWidth: 2.5,
                data: [],
                pointRadius: 0,
                tension: 0.4,
                fill: true,
                cubicInterpolationMode: 'monotone'
            });
        }
        
        if (hasOutputVoltage) {
            // Create a gradient for filling under the output line
            const outputGradient = ctx.createLinearGradient(0, 0, 0, 300);
            outputGradient.addColorStop(0, 'rgba(102, 218, 38, 0.2)');
            outputGradient.addColorStop(1, 'rgba(102, 218, 38, 0.0)');
            
            datasets.push({
                label: 'Output Voltage',
                backgroundColor: outputGradient,
                borderColor: '#66DA26',
                borderWidth: 2.5,
                data: [],
                pointRadius: 0,
                tension: 0.4,
                fill: true,
                cubicInterpolationMode: 'monotone'
            });
        }
        
        // If no metrics are available, show a message
        if (datasets.length === 0) {
            console.warn('No voltage metrics available for realtime chart');
            const infoDiv = document.createElement('div');
            infoDiv.className = 'chart-no-data';
            infoDiv.textContent = 'No voltage data available for this UPS';
            container.appendChild(infoDiv);
            return;
        }
        
        // Chart.js chart configuration
        const chartConfig = {
            type: 'line',
            data: {
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    streaming: {
                        duration: 60000, // Show only 60 seconds
                        refresh: 1000,
                        delay: 1000,
                        onRefresh: this.onVoltageChartRefresh.bind(this)
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
                                const values = [];
                                context.chart.data.datasets.forEach(dataset => {
                                    values.push(...dataset.data.map(d => d.y));
                                });
                                const maxValue = Math.max(...values);
                                // Ensure a minimum of at least 120V to always display the chart
                                return Math.max(120, Math.ceil(maxValue * 1.1));
                            }
                            return 120;
                        },
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: '#2E93fA'
                        },
                        title: {
                            display: true,
                            text: 'Voltage (V)',
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
        this.voltageChart = new Chart(ctx, chartConfig);
        
        // Save reference to available metrics for updating
        this.realtimeHasInputVoltage = hasInputVoltage;
        this.realtimeHasOutputVoltage = hasOutputVoltage;
        
        webLogger.console('Realtime Chart.js initialized for voltage with available metrics');
    }

    initializeRealtimeTransferChart() {
        // Get the chart container
        const container = document.querySelector('#transferChart');
        if (!container) {
            console.error('Container #transferChart not found');
            return;
        }
        
        // If an ApexCharts chart already exists, destroy it
        if (this.transferChart && typeof this.transferChart.destroy === 'function') {
            this.transferChart.destroy();
        }
        
        // Remove the ApexCharts element and create a new canvas
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        canvas.id = 'realtimeTransferChart';
        container.appendChild(canvas);
        
        const ctx = canvas.getContext('2d');
        
        // Create gradients for filling under the lines
        const gradientLow = ctx.createLinearGradient(0, 0, 0, 300);
        gradientLow.addColorStop(0, 'rgba(255, 69, 96, 0.2)');
        gradientLow.addColorStop(1, 'rgba(255, 69, 96, 0.0)');
        
        const gradientHigh = ctx.createLinearGradient(0, 0, 0, 300);
        gradientHigh.addColorStop(0, 'rgba(255, 69, 96, 0.2)');
        gradientHigh.addColorStop(1, 'rgba(255, 69, 96, 0.0)');
        
        // Initialize the data buffers
        this.transferLowBuffer = [];
        this.transferHighBuffer = [];
        
        // Chart.js chart configuration
        const chartConfig = {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Transfer Low',
                        backgroundColor: gradientLow,
                        borderColor: '#FF4560',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: false,
                        cubicInterpolationMode: 'monotone'
                    },
                    {
                        label: 'Transfer High',
                        backgroundColor: gradientHigh,
                        borderColor: '#FF4560',
                        borderWidth: 2.5,
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: false,
                        cubicInterpolationMode: 'monotone'
                    },
                    {
                        label: 'Nominal Reference',
                        backgroundColor: 'rgba(84, 110, 122, 0.1)',
                        borderColor: '#546E7A',
                        borderWidth: 1.5,
                        borderDash: [5, 5],
                        data: [],
                        pointRadius: 0,
                        tension: 0.4,
                        fill: false
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
                        onRefresh: this.onTransferChartRefresh.bind(this)
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
                        // Improved configuration for auto zoom
                        adaprive: true,  // Enable automatic adaptation
                        min: (context) => {
                            if (context.chart.data.datasets[0].data.length > 0 || 
                                context.chart.data.datasets[1].data.length > 0) {
                                const values = [];
                                context.chart.data.datasets.forEach(dataset => {
                                    values.push(...dataset.data.map(d => d.y));
                                });
                                const minValue = Math.min(...values);
                                
                                // Calculate a lower margin of 10%
                                const margin = (Math.max(...values) - minValue) * 0.1;
                                return Math.max(0, minValue - margin);
                            }
                            // If there is no data, use a more flexible default value
                            return 'auto';
                        },
                        max: (context) => {
                            if (context.chart.data.datasets[0].data.length > 0 || 
                                context.chart.data.datasets[1].data.length > 0) {
                                const values = [];
                                context.chart.data.datasets.forEach(dataset => {
                                    values.push(...dataset.data.map(d => d.y));
                                });
                                const maxValue = Math.max(...values);
                                
                                // Calculate an upper margin of 10%
                                const margin = (maxValue - Math.min(...values)) * 0.1;
                                return maxValue + margin;
                            }
                            // If there is no data, use a more flexible default value
                            return 'auto';
                        },
                        ticks: {
                            color: '#FF4560',
                            // Limit the number of divisions to avoid too many labels
                            maxTicksLimit: 5
                        },
                        grace: '5%', // Add a small space to the edges
                        title: {
                            display: true,
                            text: 'Voltage (V)',
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
        this.transferChart = new Chart(ctx, chartConfig);
        
        webLogger.console('Realtime Chart.js initialized for transfer thresholds');
    }

    // Method to update the voltage chart in real time
    onVoltageChartRefresh(chart) {
        return fetch('/api/ups/cache')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data && Array.isArray(result.data)) {
                    const data = result.data[1];
                    const now = Date.now();
                    
                    // Extract the voltage values only for the available metrics
                    const inputVoltage = this.realtimeHasInputVoltage ? parseFloat(data.input_voltage || 0) : null;
                    const outputVoltage = this.realtimeHasOutputVoltage ? parseFloat(data.output_voltage || 0) : null;
                    
                    // Add new points to the buffer only for the available metrics
                    const bufferEntry = { time: now };
                    if (inputVoltage !== null) bufferEntry.input = inputVoltage;
                    if (outputVoltage !== null) bufferEntry.output = outputVoltage;
                    
                    this.voltageDataBuffer.push(bufferEntry);

                    // Keep the buffer at the correct size
                    if (this.voltageDataBuffer.length > this.bufferSize) {
                        this.voltageDataBuffer.shift();
                    }

                    // Update the datasets based on the available metrics
                    let datasetIndex = 0;
                    
                    // Update the input voltage dataset if available
                    if (this.realtimeHasInputVoltage) {
                        const smoothedInput = this.calculateSmoothedValue(this.voltageDataBuffer, 'input');
                        chart.data.datasets[datasetIndex].data.push({
                            x: now,
                            y: smoothedInput
                        });
                        datasetIndex++;
                    }
                    
                    // Update the output voltage dataset if available
                    if (this.realtimeHasOutputVoltage) {
                        const smoothedOutput = this.calculateSmoothedValue(this.voltageDataBuffer, 'output');
                        chart.data.datasets[datasetIndex].data.push({
                            x: now,
                            y: smoothedOutput
                        });
                    }

                    // Update also the statistics data
                    this.updateWidgetValues(data);
                    
                    chart.update('quiet');
                }
            })
            .catch(error => console.error('Error fetching voltage data for chart:', error));
    }

    // Method to update the transfer chart in real time
    onTransferChartRefresh(chart) {
        return fetch('/api/ups/cache')
            .then(response => response.json())
            .then(result => {
                if (result.success && result.data && Array.isArray(result.data)) {
                    const data = result.data[1];
                    
                    // Extract the transfer values
                    const transferLow = parseFloat(data.input_transfer_low || 0);
                    const transferHigh = parseFloat(data.input_transfer_high || 0);
                    const voltageNominal = parseFloat(data.input_voltage_nominal || 0);
                    
                    const now = Date.now();

                    // Add new points to the buffer
                    this.transferLowBuffer.push({
                        time: now,
                        value: transferLow
                    });
                    
                    this.transferHighBuffer.push({
                        time: now,
                        value: transferHigh
                    });

                    // Keep the buffers at the correct size
                    if (this.transferLowBuffer.length > this.bufferSize) {
                        this.transferLowBuffer.shift();
                    }
                    
                    if (this.transferHighBuffer.length > this.bufferSize) {
                        this.transferHighBuffer.shift();
                    }

                    // Calculate the smoothed points using the buffers
                    const smoothedLow = this.calculateSmoothedValueSimple(this.transferLowBuffer);
                    const smoothedHigh = this.calculateSmoothedValueSimple(this.transferHighBuffer);

                    // Add the smoothed points to the chart datasets
                    chart.data.datasets[0].data.push({
                        x: now,
                        y: smoothedLow
                    });
                    
                    chart.data.datasets[1].data.push({
                        x: now,
                        y: smoothedHigh
                    });
                    
                    chart.data.datasets[2].data.push({
                        x: now,
                        y: voltageNominal
                    });
                    
                    chart.update('quiet');
                }
            })
            .catch(error => console.error('Error fetching transfer data for chart:', error));
    }

    // Method to calculate the smoothed value (version for objects with properties)
    calculateSmoothedValue(buffer, property) {
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
            smoothedValue += buffer[i][property] * weights[i];
        }
        
        return smoothedValue / weightSum;
    }

    // Method to calculate the smoothed value (version for objects with .value)
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

    // Method to convert a hex color to rgba
    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // New function to reset the charts: destroy the instances and reinitialize them
    resetCharts() {
        if (this.voltageChart) {
            this.voltageChart.destroy();
            this.voltageChart = null;
        }
        if (this.voltageNominalChart) {
            this.voltageNominalChart.destroy();
            this.voltageNominalChart = null;
        }
        if (this.transferChart) {
            this.transferChart.destroy();
            this.transferChart = null;
        }
    }

    async checkHistoricalData() {
        try {
            // Request historical voltage data for "day" period
            const response = await fetch('/api/voltage/history?period=today');
            const data = await response.json();
            
            if (!data.success) {
                webLogger.error('API returned error:', data.error);
                return false;
            }

            if (!data.data) {
                webLogger.error('No data returned from API');
                return false;
            }

            // Set a minimum threshold, for example at least 2 points for a metric
            const threshold = 2;

            // Check that at least one of the metrics has a number of points >= threshold
            const hasEnoughData = Object.keys(data.data).some(key => {
                return Array.isArray(data.data[key]) && data.data[key].length >= threshold;
            });

            webLogger.data(`Historical data check - Has enough data: ${hasEnoughData}`);
            if (hasEnoughData) {
                Object.keys(data.data).forEach(key => {
                    webLogger.data(`Points available for ${key}: ${data.data[key]?.length || 0}`);
                });
            }

            return hasEnoughData;
        } catch (error) {
            webLogger.error('Error checking voltage historical data:', error);
            return false;
        }
    }

    updateWidgetValues(metrics) {
        document.querySelectorAll('.stat-value').forEach(element => {
            const type = element.dataset.type;
            if (!type || !metrics[type]) return;

            let value = metrics[type];
            let displayValue;

            if (type === 'input_sensitivity') {
                displayValue = value;
            } else {
                value = parseFloat(value);
                if (isNaN(value)) return;
                
                displayValue = value.toFixed(1);
                
                // Add the appropriate unit of measurement
                if (type.includes('voltage') || type.includes('transfer')) {
                    displayValue += 'V';
                } else if (type.includes('current')) {
                    displayValue += 'A';
                } else if (type.includes('frequency')) {
                    displayValue += 'Hz';
                }
            }

            element.textContent = displayValue;
        });
    }

    showCharts() {
        // Make all charts containers visible
        document.querySelectorAll('.chart-container').forEach(container => {
            container.classList.remove('hidden');
            // Remove also display:none if present
            container.style.removeProperty('display');
        });
    }

    hideCharts() {
        document.querySelectorAll('.chart-container').forEach(container => {
            container.classList.add('hidden');
        });
    }
}

// Initialize VoltagePage once the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    new VoltagePage();
});