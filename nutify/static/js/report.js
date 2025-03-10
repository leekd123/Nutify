class ReportManager {
    constructor() {
        this.initializeEventListeners();
        this.isProcessing = false;
        this.lastSubmitTime = 0;  // For preventing double submissions
    }

    initializeEventListeners() {
        // Save report settings
        const saveButton = document.getElementById('saveReportSettings');
        if (saveButton) {
            saveButton.addEventListener('click', () => this.saveReportSettings());
        }

        // Send report now
        const sendButton = document.getElementById('sendReportNow');
        if (sendButton) {
            sendButton.addEventListener('click', () => this.sendReportNow());
        }

        // Initialize date inputs with default values
        this.initializeDateInputs();
    }

    initializeDateInputs() {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const fromDateInput = document.getElementById('report_from_date');
        const toDateInput = document.getElementById('report_to_date');

        if (fromDateInput) {
            fromDateInput.value = yesterday.toISOString().split('T')[0];
        }
        if (toDateInput) {
            toDateInput.value = today.toISOString().split('T')[0];
        }
    }

    validateSettings() {
        const reportTypes = Array.from(document.querySelectorAll('input[name="report_types"]:checked'))
            .map(cb => cb.value);

        if (reportTypes.length === 0) {
            this.showError('Please select at least one report type');
            return false;
        }

        const fromDate = document.getElementById('report_from_date').value;
        const toDate = document.getElementById('report_to_date').value;

        if (!fromDate || !toDate) {
            this.showError('Please select both start and end dates');
            return false;
        }

        return true;
    }

    async saveReportSettings() {
        // Prevent double submissions within 2 seconds
        const now = Date.now();
        if (!this.validateSettings() || this.isProcessing || (now - this.lastSubmitTime < 2000)) {
            return;
        }
        this.lastSubmitTime = now;

        try {
            this.isProcessing = true;
            const saveButton = document.getElementById('saveReportSettings');
            if (saveButton) {
                saveButton.disabled = true;
            }

            const settings = this.getReportSettings();
            
            const response = await fetch('/api/settings/report', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(settings)
            });

            const result = await response.json();
            
            if (result.success) {
                this.showSuccess('Report settings saved successfully');
            } else {
                this.showError(result.error || 'Failed to save report settings');
            }
        } catch (error) {
            console.error('Error saving report settings:', error);
            this.showError('Failed to save report settings');
        } finally {
            this.isProcessing = false;
            const saveButton = document.getElementById('saveReportSettings');
            if (saveButton) {
                saveButton.disabled = false;
            }
        }
    }

    async sendReportNow() {
        if (!this.validateSettings() || this.isProcessing) return;

        try {
            this.isProcessing = true;
            const sendButton = document.getElementById('sendReportNow');
            if (sendButton) {
                sendButton.disabled = true;
                sendButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
            }

            const settings = this.getReportSettings();
            
            const response = await fetch('/api/report/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(settings)
            });

            const result = await response.json();
            
            if (result.success) {
                this.showSuccess('Report sent successfully');
            } else {
                this.showError(result.error || 'Failed to send report');
            }
        } catch (error) {
            console.error('Error sending report:', error);
            this.showError('Failed to send report');
        } finally {
            this.isProcessing = false;
            const sendButton = document.getElementById('sendReportNow');
            if (sendButton) {
                sendButton.disabled = false;
                sendButton.innerHTML = '<i class="fas fa-paper-plane"></i> Send Report Now';
            }
        }
    }

    getReportSettings() {
        const reportTypes = Array.from(document.querySelectorAll('input[name="report_types"]:checked'))
            .map(cb => cb.value);

        return {
            report_types: reportTypes,
            from_date: document.getElementById('report_from_date')?.value,
            to_date: document.getElementById('report_to_date')?.value
        };
    }

    showSuccess(message) {
        if (window.showNotification) {
            window.showNotification(message, 'success');
        } else {
            alert(message);
        }
    }

    showError(message) {
        if (window.showNotification) {
            window.showNotification(message, 'error');
        } else {
            alert(message);
        }
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    webLogger.console('Initializing ReportManager');
    window.reportManager = new ReportManager();
}); 