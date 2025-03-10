if (!window.webLogger) {
    class WebLogger {
        constructor() {
            this.enabled = true;  // Logging state
            this.logLevel = 'info';  // Default level
            
            // Load saved preferences
            this.loadPreferences();
            
            // Styles for different log types
            this.styles = {
                page: 'color: #2563eb; font-weight: bold;',        // Blue
                data: 'color: #059669; font-weight: bold;',        // Green
                chart: 'color: #7c3aed; font-weight: bold;',       // Purple
                widget: 'color: #db2777; font-weight: bold;',      // Pink
                event: 'color: #ea580c; font-weight: bold;',       // Orange
                error: 'color: #dc2626; font-weight: bold;',       // Red
                warning: 'color: #d97706; font-weight: bold;',     // Yellow
                scheduler: 'color: #6b7280; font-weight: bold;'   // Gray for Scheduler
            };
        }

        // Load preferences from localStorage
        loadPreferences() {
            this.enabled = localStorage.getItem('webLogger.enabled') === 'false';
            this.logLevel = localStorage.getItem('webLogger.level') || 'info';
        }

        // Enable/Disable logging
        enable(status = true) {
            this.enabled = status;
            localStorage.setItem('webLogger.enabled', status);
        }

        // Set logging level
        setLevel(level) {
            this.logLevel = level;
            localStorage.setItem('webLogger.level', level);
        }

        // Logging methods for different contexts
        page(message, data = null) {
            this._log('page', '📄 Page', message, data);
        }

        data(message, data = null) {
            this._log('data', '📊 Data', message, data);
        }

        chart(message, data = null) {
            this._log('chart', '📈 Chart', message, data);
        }

        widget(message, data = null) {
            this._log('widget', '🔧 Widget', message, data);
        }

        event(message, data = null) {
            this._log('event', '🔔 Event', message, data);
        }

        error(message, error = null) {
            this._log('error', '❌ Error', message, error, true);
        }

        warning(message, data = null) {
            this._log('warning', '⚠️ Warning', message, data);
        }
        console(message, data = null) {
            this._log('console', '💬 Console', message, data);
        }

        // Internal method for logging
        _log(type, prefix, message, data = null, isError = false) {
            if (!this.enabled) return;

            const timestamp = new Date().toLocaleTimeString();
            const style = this.styles[type];

            if (isError) {
                console.group(`%c[${timestamp}] ${prefix}: ${message}`, style);
                if (data) console.error(data);
                console.groupEnd();
            } else {
                console.group(`%c[${timestamp}] ${prefix}: ${message}`, style);
                if (data) console.log(data);
                console.groupEnd();
            }
        }

        // Method to print page statistics
        pageStats(stats) {
            if (!this.enabled) return;
            
            console.group('%c📊 Page Statistics', 'color: #2563eb; font-weight: bold;');
            Object.entries(stats).forEach(([key, value]) => {
                console.log(`%c${key}: `, 'color: #4b5563', value);
            });
            console.groupEnd();
        }
    }
    window.webLogger = new WebLogger();
} 