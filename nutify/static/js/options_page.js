// Function to clear form fields
function clearFormFields() {
    const emailForm = document.getElementById('emailConfigForm');
    if (!emailForm) return;

    const inputs = emailForm.querySelectorAll('input:not([type="submit"])');
    inputs.forEach(input => {
        if (input.type === 'checkbox') {
            input.checked = false;
        } else {
            input.value = '';
        }
    });
}

// Load existing email configuration
function loadEmailConfig() {
    fetch('/api/settings/mail')
        .then(response => response.json())
        .then(data => {
            // If there is no configuration, initialize empty fields without errors
            if (!data || !data.success || !data.data || Object.keys(data.data).length === 0) {
                clearFormFields();
                setConfiguredState(false);
                return;
            }

            const config = data.data;
            
            // Set all fields
            document.getElementById('email_provider').value = config.provider || '';
            document.getElementById('smtp_server').value = config.smtp_server || '';
            document.getElementById('smtp_port').value = config.smtp_port || '';
            document.getElementById('from_name').value = config.from_name || '';
            document.getElementById('from_email').value = config.from_email || '';
            document.getElementById('username').value = config.username || '';
            document.getElementById('enabled').checked = config.enabled || false;
            
            // Show configuration status
            setConfiguredState(
                config.smtp_server && config.smtp_port && config.from_email && config.username,
                config
            );
            
            // Show last test if available
            if (config.last_test_date) {
                const testDate = new Date(config.last_test_date).toLocaleString();
                const status = config.last_test_status ? 'Success' : 'Failed';
                const lastTestInfo = document.getElementById('lastTestInfo');
                if (lastTestInfo) {
                    lastTestInfo.innerHTML = 
                        `Last test: ${testDate} - Status: <span class="${config.last_test_status ? 'text-success' : 'text-danger'}">${status}</span>`;
                }
            }
        })
        .catch(error => {
            console.warn('Email config not found:', error);
            clearFormFields();
            setConfiguredState(false);
        });
}

function setConfiguredState(isConfigured, config = {}) {
    const configButtons = document.getElementById('configurationButtons');
    const configStatus = document.getElementById('configurationStatus');
    const formInputs = document.querySelectorAll('.options_mail_form_group input, .options_mail_form_group select');
    const providerInfo = document.querySelector('.provider-info');
    
    if (isConfigured) {
        // Hide configuration form and show status
        configButtons.classList.add('hidden');
        configStatus.classList.remove('hidden');
        formInputs.forEach(input => input.disabled = true);
        
        // Show provider info if configured
        if (config.provider) {
            const providerSelect = document.getElementById('email_provider');
            const selectedOption = providerSelect.querySelector(`option[value="${config.provider}"]`);
            if (selectedOption) {
                providerInfo.textContent = `Provider: ${selectedOption.textContent}`;
            } else {
                providerInfo.textContent = 'Provider: Custom Configuration';
            }
        } else {
            providerInfo.textContent = 'Provider: Custom Configuration';
        }
    } else {
        // Show configuration form and hide status
        configButtons.classList.remove('hidden');
        configStatus.classList.add('hidden');
        formInputs.forEach(input => input.disabled = false);
    }
}

// Handles the reconfigure button
document.getElementById('reconfigureBtn').addEventListener('click', function() {
    setConfiguredState(false);
});

// Independent checkbox Enable Email Notifications
document.getElementById('enabled').addEventListener('change', function() {
    const enabled = this.checked;
    
    fetch('/api/settings/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled, update_enabled_only: true })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showAlert('emailStatus', `Email notifications ${enabled ? 'enabled' : 'disabled'}`, 'success');
            
            // Enable/disable dependent settings
            const dependentSections = document.getElementById('notification_dependent_sections');
            const warningElement = document.getElementById('email_config_warning');
            if (enabled) {
                dependentSections.classList.remove('hidden');
                warningElement.classList.add('hidden');
            } else {
                dependentSections.classList.add('hidden');
                warningElement.classList.remove('hidden');
                
                // Disable report scheduler when disabling email notifications
                fetch('/api/settings/report/disable', { method: 'POST' })
                .then(response => response.json())
                .then(reportData => {
                    if (reportData.success) {
                        webLogger.console('Report scheduler disabled');
                    } else {
                        console.error('Failed to disable report scheduler:', reportData.message);
                    }
                })
                .catch(err => console.error('Error disabling report scheduler:', err));
            }
        } else {
            this.checked = !enabled; // Revert checkbox state on failure
            showAlert('emailStatus', 'Error updating notification status', 'danger');
        }
    })
    .catch(error => {
        console.error('Error:', error);
        this.checked = !enabled;
        showAlert('emailStatus', 'Error updating notification status', 'danger');
    });
});

// Remove enabled from main form
document.getElementById('emailConfigForm').addEventListener('submit', function(e) {
    e.preventDefault();
    const formData = new FormData(this);
    const config = {};
    
    // Manually add the provider since it's outside the form
    const provider = document.getElementById('email_provider').value;
    config.provider = provider;
    
    formData.forEach((value, key) => {
        if (key === 'password' && !value) {
            // Skip empty password
        } else if (key !== 'enabled') { // Ignore enabled field
            config[key] = value;
        }
    });

    console.log('Saving config with provider:', config.provider);

    fetch('/api/settings/mail', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showAlert('emailStatus', 'Configuration saved successfully', 'success');
            loadEmailConfig();  // Immediately reload email configuration
            loadNotifySettings();  // Reload notification settings
            const scheduler = new ReportScheduler();  // Reinitialize scheduler
            scheduler.loadSchedules();  // Reload schedules
            
            // Force complete page reload after showing success message
            setTimeout(() => {
                location.href = location.href;
            }, 1500);
        } else {
            showAlert('emailStatus', 'Error saving configuration: ' + data.message, 'danger');
        }
    })
    .catch(error => {
        console.error('Error:', error);
        showAlert('emailStatus', 'Error saving configuration', 'danger');
    });
});

// Test email
document.getElementById('testEmailBtn').addEventListener('click', function() {
    const button = this;
    const originalContent = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Testing...</span>`;

    // Collect form data for testing email
    const formData = new FormData(document.getElementById('emailConfigForm'));
    const config = {};
    formData.forEach((value, key) => {
        if (key === 'enabled') {
            config[key] = true;
        } else if (key === 'password' && !value) {
            // If empty, use the existing one (leave it empty so the server maintains the current one)
        } else {
            config[key] = value;
        }
    });

    fetch('/api/settings/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showAlert('emailStatus', 'Test email sent successfully', 'success');
            document.getElementById('saveConfigBtn').classList.remove('hidden');
        } else {
            showAlert('emailStatus', 'Error sending test email: ' + (data.error || 'Failed to send test email'), 'danger');
            document.getElementById('saveConfigBtn').classList.add('hidden');
        }
    })
    .catch(error => {
        console.error('Error:', error);
        showAlert('emailStatus', 'Error sending test email', 'danger');
    })
    .finally(() => {
        button.disabled = false;
        button.innerHTML = originalContent;
    });
});

// When any field of the form is modified, hide the Save Configuration button
document.querySelectorAll('.options_mail_form_group input').forEach(input => {
    input.addEventListener('input', function() {
        document.getElementById('saveConfigBtn').classList.add('hidden');
    });
});

// Function to show alerts
function showAlert(containerId, message, type) {
    const container = document.getElementById(containerId);
    if(!container) return;
    container.textContent = message;
    // Set the style based on the type
    container.className = 'options_alert ' + (type === 'success' ? 'options_alert_success' : 'options_alert_danger');
    container.classList.remove('hidden');
    // Remove the message after 3 seconds
    setTimeout(() => {
        container.classList.add('hidden');
    }, 3000);
}

// Load notification settings
async function loadNotifySettings() {
    // Reset checkboxes
    document.querySelectorAll('.options_nutify_checkbox').forEach(checkbox => {
        checkbox.checked = false;
    });
    
    try {
        const response = await fetch('/api/settings/nutify');
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.data) {
                data.data.forEach(setting => {
                    const checkbox = document.querySelector(`input[data-event-type="${setting.event_type}"]`);
                    if (checkbox) {
                        checkbox.checked = setting.enabled;
                    }
                });
            }
        }
    } catch (error) {
        console.error('Error loading notification settings:', error);
    }
}

// Tab management
document.addEventListener('DOMContentLoaded', function() {
    // Add these logs
    webLogger.console('Page loaded');
    webLogger.console('systemLogEnabled:', document.getElementById('systemLogEnabled').checked);
    webLogger.console('werkzeugLogEnabled:', document.getElementById('werkzeugLogEnabled').checked);

    // Select all tab buttons
    const tabButtons = document.querySelectorAll('.options_tab_button');
    // Select all tab contents
    const tabContents = document.querySelectorAll('.options_tab_content');

    // Add event listener for each button
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Remove the active class from all buttons
            tabButtons.forEach(btn => btn.classList.remove('active'));
            // Add the active class to the clicked button
            button.classList.add('active');

            // Hide all tab contents
            tabContents.forEach(content => content.classList.add('hidden'));
            
            // Show the selected tab content
            const tabId = `${button.dataset.tab}_tab`;
            const selectedTab = document.getElementById(tabId);
            if (selectedTab) {
                selectedTab.classList.remove('hidden');
            }
        });
    });

    // Load initial configurations
    loadEmailConfig();
    loadNotifySettings();
    loadVariablesConfig();
    loadDatabaseStats();

    // Instead of reading only the state, force the update of the checkboxes
    const systemLogEnabled = document.getElementById('systemLogEnabled');
    const werkzeugLogEnabled = document.getElementById('werkzeugLogEnabled');
    
    // Instead of reading only the state, force the update of the checkboxes
    fetch('/api/settings/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) // Empty object to maintain the format
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            webLogger.console('Received settings from server:', data.data);
            systemLogEnabled.checked = data.data.log;
            werkzeugLogEnabled.checked = data.data.werkzeug;
            
            // Set the log level
            const logLevelSelect = document.getElementById('logLevelSelect');
            if (logLevelSelect) {
                logLevelSelect.value = data.data.level;
            }
            
            webLogger.console('Updated UI - systemLog:', systemLogEnabled.checked, 
                      'werkzeug:', werkzeugLogEnabled.checked,
                      'level:', logLevelSelect ? logLevelSelect.value : 'not found');
        }
    });

    // Initialize scheduler
    const scheduler = new ReportScheduler();
    window.scheduler = scheduler;  // Make it available globally

    // Ensure that the log CSS file is loaded
    const logStylesheet = document.createElement('link');
    logStylesheet.rel = 'stylesheet';
    logStylesheet.id = 'log-styles';
    
    // Remove any previous stylesheets with the same ID
    const existingStylesheet = document.getElementById('log-styles');
    if (existingStylesheet) {
        existingStylesheet.remove();
    }
    
    document.head.appendChild(logStylesheet);
    
    // Force the application of the styles to the log container
    const logPreview = document.getElementById('logPreview');
    if (logPreview) {
        // Apply directly the styles to ensure they are respected
        Object.assign(logPreview.style, {
            maxHeight: '600px',
            overflowY: 'auto',
            border: '1px solid #30363d',
            borderRadius: '4px',
            backgroundColor: '#0d1117',
            padding: '8px',
            fontSize: '0.85rem',
            lineHeight: '1.1',
            fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
            color: '#e6e6e6'
        });
    }
});

// Add event listener 'change' to all notification checkboxes for automatic saving
document.querySelectorAll('.options_nutify_checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', async function() {
        // Save the current state to restore in case of error
        const originalState = this.checked;
        const eventType = this.dataset.eventType;
        
        // Temporarily disable the checkbox during saving
        this.disabled = true;
        
        try {
            // Prepare data for updating this single checkbox
            const setting = {
                event_type: eventType,
                enabled: originalState
            };
            
            // Show a message that indicates we are saving
            showAlert('options_nutify_status', `Saving ${eventType} notification setting...`, 'info');
            
            const response = await fetch('/api/settings/nutify/single', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(setting)
            });
            
            if (response.ok) {
                // Show success message
                showAlert('options_nutify_status', `${eventType} notification ${originalState ? 'enabled' : 'disabled'}`, 'success');
            } else {
                // Show error and restore the original state
                console.error('Error saving notification setting:', response.status);
                showAlert('options_nutify_status', `Error saving ${eventType} notification setting (${response.status})`, 'danger');
                this.checked = !originalState;
            }
        } catch (error) {
            // Handle exceptions
            console.error('Exception:', error);
            showAlert('options_nutify_status', `Error saving notification setting: ${error.message}`, 'danger');
            this.checked = !originalState;
        } finally {
            // Re-enable the checkbox
            this.disabled = false;
        }
    });
});

// Specific function for notification alerts
function showNotifyAlert(message, type = 'success') {
    const container = document.getElementById('options_nutify_status');
    if (!container) {
        console.error('Notification alert container not found');
        return;
    }
    
    container.textContent = message;
    container.className = `options_alert options_alert_${type}`;
    container.classList.remove('hidden');
    
    setTimeout(() => {
        container.classList.add('hidden');
    }, 3000);
}

// Variables Configuration
async function loadVariablesConfig() {
    try {
        const response = await fetch('/api/settings/variables');
        if (response.ok) {
            const data = await response.json();
            if (data.success && data.data) {
                document.getElementById('currency').value = data.data.currency;
                document.getElementById('kwh_cost').value = parseFloat(data.data.price_per_kwh).toFixed(4);
                document.getElementById('co2_factor').value = parseFloat(data.data.co2_factor).toFixed(4);
                updateCurrencySymbol(data.data.currency || 'EUR');
            }
        }
    } catch (error) {
        console.error('Error loading variables settings:', error);
    }
}

// Currency icon mapping
const currencyIcons = {
    'EUR': 'fa-euro-sign',
    'USD': 'fa-dollar-sign',
    'GBP': 'fa-pound-sign',
    'JPY': 'fa-yen-sign',
    'AUD': 'fa-dollar-sign',
    'CAD': 'fa-dollar-sign',
    'CHF': 'fa-franc-sign',
    'CNY': 'fa-yen-sign',
    'INR': 'fa-rupee-sign',
    'NZD': 'fa-dollar-sign',
    'BRL': 'fa-money-bill',
    'RUB': 'fa-ruble-sign',
    'KRW': 'fa-won-sign',
    'default': 'fa-money-bill'
};

// Update the currency icon when the selection changes
document.getElementById('currency').addEventListener('change', function() {
    const currencyIcon = document.getElementById('currencyIcon');
    const selectedCurrency = this.value;
    
    // Remove all existing fa-* classes
    currencyIcon.className = 'fas';
    
    // Add the new icon class
    const iconClass = currencyIcons[selectedCurrency] || currencyIcons.default;
    currencyIcon.classList.add(iconClass);
    
    // Update the currency symbol in the cost input
    updateCurrencySymbol(selectedCurrency);
});

function updateCurrencySymbol(currency) {
    const symbolMap = {
        'USD': 'USD',
        'EUR': 'EUR',
        'GBP': 'GBP',
        'JPY': 'JPY',
        'AUD': 'AUD',
        'CAD': 'CAD',
        'CHF': 'CHF',
        'CNY': 'CNY',
        'INR': 'INR',
        'NZD': 'NZD',
        'BRL': 'BRL',
        'RUB': 'RUB',
        'KRW': 'KRW'
    };
    document.getElementById('currencySymbol').textContent = symbolMap[currency] || currency;
}

// Function to update currency symbol in energy page
function updateEnergyPageCurrencySymbol(currency) {
    const symbolMap = {
        'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥',
        'AUD': 'A$', 'CAD': 'C$', 'CHF': 'Fr',
        'CNY': '¥', 'INR': '₹', 'NZD': 'NZ$',
        'BRL': 'R$', 'RUB': '₽', 'KRW': '₩'
    };
    const energyPageSymbol = document.querySelector('.energy_stat_card .stat-icon i.fas');
    if (energyPageSymbol) {
        if (currency === 'EUR') {
            energyPageSymbol.classList.remove('fa-dollar-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-ruble-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-euro-sign');
        } else if (currency === 'USD') {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-ruble-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-dollar-sign');
        } else if (currency === 'GBP') {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-dollar-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-ruble-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-pound-sign');
        } else if (currency === 'JPY' || currency === 'CNY') {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-dollar-sign', 'fa-pound-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-ruble-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-yen-sign');
        } else if (currency === 'CHF') {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-dollar-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-rupee-sign', 'fa-ruble-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-franc-sign');
        } else if (currency === 'INR') {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-dollar-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-ruble-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-rupee-sign');
        } else if (currency === 'RUB') {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-dollar-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-ruble-sign');
        } else if (currency === 'KRW') {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-dollar-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-won-sign');
        } else {
            energyPageSymbol.classList.remove('fa-euro-sign', 'fa-pound-sign', 'fa-yen-sign', 'fa-franc-sign', 'fa-rupee-sign', 'fa-ruble-sign', 'fa-won-sign');
            energyPageSymbol.classList.add('fa-dollar-sign');
        }
    }
}

// Save variables configuration
document.getElementById('variablesConfigForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const formData = new FormData(this);
    const config = {
        currency: formData.get('currency'),
        price_per_kwh: parseFloat(formData.get('kwh_cost')),
        co2_factor: parseFloat(formData.get('co2_factor'))
    };

    try {
        const response = await fetch('/api/settings/variables', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });

        const result = await response.json();
        if (result.success) {
            showAlert('variablesStatus', 'Variables saved successfully', 'success');
        } else {
            showAlert('variablesStatus', 'Error saving variables: ' + (result.message || 'Failed to save'), 'danger');
        }
    } catch (error) {
        console.error('Error:', error);
        showAlert('variablesStatus', 'Error saving variables', 'danger');
    }
});

// Load all configurations on page load
document.addEventListener('DOMContentLoaded', () => {
    // Existing initialization code...
    
    // Initialize new sections
    loadDatabaseStats();
    loadLogs();
    loadSystemInfo();
});

// Database Management
async function loadDatabaseStats() {
    try {
        const response = await fetch('/api/database/stats');
        const data = await response.json();
        
        if (data.success) {
            // Update general statistics
            document.getElementById('dbSize').textContent = formatBytes(data.data.size);
            document.getElementById('totalRecords').textContent = data.data.total_records.toLocaleString();
            document.getElementById('lastWrite').textContent = data.data.last_write ? 
                new Date(data.data.last_write).toLocaleString() : 'Never';
            
            // Update table information
            const tablesInfo = document.getElementById('tablesInfo');
            tablesInfo.innerHTML = '';
            
            for (const [tableName, tableData] of Object.entries(data.data.tables)) {
                const tableCard = document.createElement('div');
                tableCard.className = 'table_info_card';
                
                const lastWrite = tableData.last_write ? 
                    new Date(tableData.last_write).toLocaleString() : 'Never';
                
                tableCard.innerHTML = `
                    <div class="table_info_header">
                        <i class="fas fa-table"></i>
                        <h4>${tableName}</h4>
                    </div>
                    <div class="table_info_stats">
                        <div class="table_info_stat">
                            <div class="table_info_stat_label">Records</div>
                            <div class="table_info_stat_value">${tableData.record_count.toLocaleString()}</div>
                        </div>
                        <div class="table_info_stat">
                            <div class="table_info_stat_label">Last Write</div>
                            <div class="table_info_stat_value">${lastWrite}</div>
                        </div>
                    </div>
                `;
                
                tablesInfo.appendChild(tableCard);
            }
        }
    } catch (error) {
        console.error('Error loading database stats:', error);
        showAlert('databaseStatus', 'Error loading database statistics', 'danger');
    }
}

// Add function to show alerts in the database section
function showDatabaseAlert(message, type = 'success') {
    const alertContainer = document.createElement('div');
    alertContainer.className = `options_alert options_alert_${type}`;
    alertContainer.textContent = message;
    
    const databaseCard = document.querySelector('.combined_card');
    databaseCard.insertBefore(alertContainer, databaseCard.firstChild);
    
    setTimeout(() => {
        alertContainer.remove();
    }, 3000);
}

// Database Actions
document.getElementById('backupDbBtn').addEventListener('click', async () => {
    const button = document.getElementById('backupDbBtn');
    const originalContent = button.innerHTML;
    try {
        button.disabled = true;
        button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Preparing Backup...</span>`;
        const response = await fetch('/api/database/backup', { method: 'GET' });
        if(response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'database_backup.db';
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            showAlert('databaseStatus', 'Backup downloaded successfully', 'success');
        } else {
            const data = await response.json();
            showAlert('databaseStatus', 'Error downloading backup: ' + data.message, 'danger');
        }
    } catch (error) {
        console.error('Error downloading backup:', error);
        showAlert('databaseStatus', 'Error downloading backup', 'danger');
    } finally {
        button.disabled = false;
        button.innerHTML = originalContent;
    }
});

// Listener for "Optimize Database"
document.getElementById('optimizeDbBtn').addEventListener('click', async () => {
    const button = document.getElementById('optimizeDbBtn');
    const originalContent = button.innerHTML;
    try {
        button.disabled = true;
        button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Optimizing...</span>`;
        const response = await fetch('/api/database/optimize', { 
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: "{}"
        });
        const data = await response.json();
        if(data.success){
            showAlert('databaseStatusOptimize', data.message, 'success');
            await loadDatabaseStats();
        } else {
            showAlert('databaseStatusOptimize', 'Error optimizing database: ' + data.message, 'danger');
        }
    } catch (error) {
        console.error('Error optimizing DB:', error);
        showAlert('databaseStatusOptimize', 'Error optimizing database', 'danger');
    } finally {
        button.disabled = false;
        button.innerHTML = originalContent;
    }
});

// Listener for "Vacuum Database"
document.getElementById('vacuumDbBtn').addEventListener('click', async () => {
    const button = document.getElementById('vacuumDbBtn');
    const originalContent = button.innerHTML;
    try {
        button.disabled = true;
        button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Vacuuming...</span>`;
        const response = await fetch('/api/database/vacuum', { 
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: "{}"
        });
        const data = await response.json();
        if(data.success){
            showAlert('databaseStatusVaccum', data.message, 'success');
            await loadDatabaseStats();
        } else {
            showAlert('databaseStatusVaccum', 'Error vacuuming database: ' + data.message, 'danger');
        }
    } catch (error) {
        console.error('Error vacuuming DB:', error);
        showAlert('databaseStatusVaccum', 'Error vacuuming database', 'danger');
    } finally {
        button.disabled = false;
        button.innerHTML = originalContent;
    }
});

// Global variables for log pagination
let currentLogPage = 1;
let hasMoreLogs = false;
let isLoadingLogs = false;
let currentLogFilters = {
    type: 'all',
    level: 'all',
    range: 'all'
};

async function loadLogs(resetPage = true) {
    if (isLoadingLogs) return;
    
    const button = document.getElementById('refreshLogsBtn');
    const originalContent = button.innerHTML;
    const preview = document.getElementById('logPreview');
    
    try {
        isLoadingLogs = true;
        button.disabled = true;
        button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Loading logs...</span>`;
        
        // Get the values of the filters
        const logType = document.getElementById('logType').value;
        const logLevel = document.getElementById('logLevel').value;
        const dateRange = document.getElementById('dateRange').value;
        
        // Update the current filters
        currentLogFilters = {
            type: logType,
            level: logLevel,
            range: dateRange
        };
        
        // Reset the page if requested (e.g. when filters change)
        if (resetPage) {
            currentLogPage = 1;
            preview.innerHTML = ''; // Clear the previous content
        }
        
        // Call the API endpoint to get the logs, encoding the parameters
        const response = await fetch(
            `/api/logs?type=${encodeURIComponent(logType)}&level=${encodeURIComponent(logLevel)}&range=${encodeURIComponent(dateRange)}&page=${currentLogPage}&page_size=1000`
        );
        const data = await response.json();
        
        if (data.success && data.data) {
            const logData = data.data;
            
            // Update the pagination state
            hasMoreLogs = logData.has_more;
            
            // If it's the first page, show the file information
            if (currentLogPage === 1) {
                const logCount = document.getElementById('logCount');
                if (logCount) {
                    logCount.textContent = `Found ${logData.total_files} log files (${formatBytes(logData.total_size)})`;
                }
            }
            
            // Add the new lines to the existing content
            if (Array.isArray(logData.lines) && logData.lines.length > 0) {
                const newContent = logData.lines.map(formatLogEntry).join('');
                
                if (resetPage) {
                    preview.innerHTML = newContent;
                } else {
                    preview.innerHTML += newContent;
                }
                
                // Apply only essential styles directly to the container
                Object.assign(preview.style, {
                    maxHeight: '600px',
                    overflowY: 'auto',
                    borderRadius: '4px',
                    padding: '8px',
                    fontSize: '0.85rem',
                    lineHeight: '1.1',
                    fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace"
                });
                
                // Add an "Load more" indicator if there are other pages
                if (hasMoreLogs) {
                    preview.innerHTML += `
                    <div id="loadMoreLogs" class="load-more-logs">
                        <button type="button">
                            <i class="fas fa-arrow-down"></i> Load More Logs
                        </button>
                    </div>`;
                    
                    // Add event listener to the "Load more" button
                    document.getElementById('loadMoreLogs').addEventListener('click', () => {
                        // Remove the "Load more" button
                        document.getElementById('loadMoreLogs').remove();
                        // Load the next page
                        currentLogPage++;
                        loadLogs(false);
                    });
                }
            } else if (currentLogPage === 1) {
                preview.textContent = 'No logs found for selected filters';
            }
            
            // Add event listener for infinite scrolling
            if (hasMoreLogs) {
                const handleScroll = () => {
                    const scrollPosition = preview.scrollTop + preview.clientHeight;
                    const scrollHeight = preview.scrollHeight;
                    
                    // If we are near the bottom and not already loading, load more logs
                    if (scrollHeight - scrollPosition < 200 && hasMoreLogs && !isLoadingLogs) {
                        // Remove the "Load more" button if it exists
                        const loadMoreBtn = document.getElementById('loadMoreLogs');
                        if (loadMoreBtn) {
                            loadMoreBtn.remove();
                        }
                        
                        // Load the next page
                        currentLogPage++;
                        loadLogs(false);
                    }
                };
                
                // Remove the previous event listener if it exists
                preview.removeEventListener('scroll', handleScroll);
                // Add the new event listener
                preview.addEventListener('scroll', handleScroll);
            }
        } else {
            if (currentLogPage === 1) {
                preview.textContent = 'No logs found for selected filters';
                
                // Update the log count
                const logCount = document.getElementById('logCount');
                if (logCount) {
                    logCount.textContent = 'Found 0 log files';
                }
            }
        }
    } catch (error) {
        console.error('Error loading logs:', error);
        showAlert('logStatus', 'Error loading logs', 'danger');
        
        if (currentLogPage === 1) {
            preview.textContent = 'Error loading logs. Please try again.';
        }
    } finally {
        isLoadingLogs = false;
        button.disabled = false;
        button.innerHTML = originalContent;
    }
}

// Add a listener to the Refresh button that invokes the loadLogs function
document.getElementById('refreshLogsBtn').addEventListener('click', loadLogs);

// Log Filter Events
document.getElementById('logType').addEventListener('change', loadLogs);
document.getElementById('logLevel').addEventListener('change', loadLogs);
document.getElementById('dateRange').addEventListener('change', loadLogs);

document.getElementById('downloadLogsBtn').addEventListener('click', async () => {
    const button = document.getElementById('downloadLogsBtn');
    const originalContent = button.innerHTML;
    
    try {
        button.disabled = true;
        button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Downloading...</span>`;
        
        const logType = document.getElementById('logType').value;
        const logLevel = document.getElementById('logLevel').value;
        const dateRange = document.getElementById('dateRange').value;
        
        const response = await fetch(`/api/logs/download?type=${logType}&level=${logLevel}&range=${dateRange}`);
        
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `logs_${new Date().toISOString()}.zip`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            
            showAlert('logStatus', 'Logs downloaded successfully', 'success');
        } else {
            showAlert('logStatus', 'Error downloading logs', 'danger');
        }
    } catch (error) {
        console.error('Error downloading logs:', error);
        showAlert('logStatus', 'Error downloading logs', 'danger');
    } finally {
        button.disabled = false;
        button.innerHTML = originalContent;
    }
});

// System Info
async function loadSystemInfo() {
    try {
        const response = await fetch('/api/system/info');
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('projectVersion').textContent = data.data.version;
            document.getElementById('lastUpdate').textContent = data.data.last_update;
            document.getElementById('projectStatus').textContent = data.data.status;
            document.getElementById('changelogText').textContent = data.data.changelog;
            // Update the class for the project status
            const statusElement = document.getElementById('projectStatus');
            
            // Remove all previous status classes and set only version-value
            statusElement.className = 'version-value';
            
            // Add a CSS class based directly on the status value
            // Remove spaces and convert to lowercase to create a valid CSS class
            if (data.data.status) {
                const statusClass = 'version-' + data.data.status.toLowerCase().replace(/\s+/g, '-');
                statusElement.classList.add(statusClass);
            }
        }
    } catch (error) {
        console.error('Error loading system info:', error);
    }
}

// Utility Functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Update the log configuration by sending both the checkbox state and the selected level.
function updateLogSettings() {
    const enabled = document.getElementById('systemLogEnabled').checked;
    const selectedLevel = document.getElementById('logLevelSelect').value;
    const werkzeugEnabled = document.getElementById('werkzeugLogEnabled').checked;
    fetch('/api/settings/log', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ log: enabled, level: selectedLevel, werkzeug: werkzeugEnabled })
    })
    .then(response => response.json())
    .then(data => {
        if(data.success){
            showAlert('logStatus', 'Log configuration updated. Restart the application to apply the changes.', 'success');
            // After a brief delay, send the request to restart the application
            setTimeout(() => {
                fetch('/api/restart', { method: 'POST' })
                .then(resp => {
                    // If the fetch returns an error, it may be due to the restart; wait for the reload.
                    return resp.json();
                })
                .then(restartData => {
                    if (restartData.success) {
                        showAlert('logStatus', 'The application is restarting...', 'success');
                    } else {
                        showAlert('logStatus', 'The application is restarting...', 'success');
                    }
                    setTimeout(() => location.reload(), 3000);
                })
                .catch(error => {
                    console.warn('Restart in progress, possible interruption of the response:', error);
                    showAlert('logStatus', 'The application is restarting...', 'success');
                    setTimeout(() => location.reload(), 3000);
                });
            }, 1000);
        } else {
            showAlert('logStatus', 'Error updating: ' + data.message, 'danger');
        }
    })
    .catch(error => {
        console.error('Error updating log setting:', error);
        showAlert('logStatus', 'Error updating log configuration', 'danger');
    });
}

// Add a listener on the "Save and Restart" button
document.getElementById('saveAndRestartBtn').addEventListener('click', updateLogSettings);

// Add a listener on the "Clear Logs" button
document.getElementById('clearLogsBtn').addEventListener('click', async () => {
    const button = document.getElementById('clearLogsBtn');
    const originalContent = button.innerHTML;
    try {
        button.disabled = true;
        button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Clearing...</span>`;
        // Get the selected log type from the filter
        const logType = document.getElementById('logType').value;
        // Request the server to clear the logs
        const response = await fetch(`/api/logs/clear?type=${logType}`, { 
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: "{}"
        });
        const data = await response.json();
        if (data.success) {
            showAlert('logStatus', data.message, 'success');
            // Reload the logs after the deletion
            loadLogs();
        } else {
            showAlert('logStatus', 'Error clearing logs: ' + data.message, 'danger');
        }
    } catch (error) {
        console.error('Error clearing logs:', error);
        showAlert('logStatus', 'Error clearing logs', 'danger');
    } finally {
        button.disabled = false;
        button.innerHTML = originalContent;
    }
});

// Improve the log formatting
function formatLogEntry(log) {
    // Get the CSS class based on the log level
    let levelClass = '';
    
    // Search for the log level in the content
    const levelMatch = log.content.match(/\[(DEBUG|INFO|WARNING|ERROR)\]/i);
    if (levelMatch) {
        levelClass = `log-${levelMatch[1].toLowerCase()}`;
    } else if (log.level) {
        levelClass = `log-${log.level.toLowerCase()}`;
    }
    
    // Extract the timestamp from the log content, if present
    let timestamp = '';
    let content = log.content;
    
    // Search for a timestamp in the ISO format or similar at the beginning of the line
    const timestampMatch = log.content.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Z+-]\d{2}:?\d{2})?)/);
    if (timestampMatch) {
        timestamp = timestampMatch[1];
        content = log.content.substring(timestamp.length).trim();
    }
    
    // Format the log line with the appropriate CSS class
    return `<div class="log-line ${levelClass}">
        <span class="log-file">${log.file}</span>
        <span class="log-number">#${log.line_number}</span>
        ${timestamp ? `<span class="log-timestamp">${timestamp}</span>` : ''}
        <span class="log-content">${content}</span>
    </div>`;
}

function getLevelClass(level) {
    const levels = {
        'DEBUG': 'debug',
        'INFO': 'info',
        'WARNING': 'warning',
        'ERROR': 'error'
    };
    return levels[level] || 'info';
}

// Report Scheduler Class
class ReportScheduler {
    constructor() {
        webLogger.console('🔄 Initializing ReportScheduler');
        this.schedules = [];
        this.modal = document.getElementById('scheduleModal');
        if (!this.modal) {
            console.error('❌ Schedule modal not found! HTML ID: scheduleModal');
            // Log the entire modal container to debug
            webLogger.console('Modal container:', document.getElementById('scheduleModal'));
        }

        // Add Schedule button
        const addBtn = document.getElementById('addSchedulerBtn');
        if (addBtn) {
            webLogger.console('✅ Add Schedule button found, attaching click handler');
            addBtn.addEventListener('click', () => {
                webLogger.console('📅 Add Schedule button clicked');
                this.showAddScheduleForm();
            });
        } else {
            console.error('❌ Add Schedule button not found! HTML ID: addSchedulerBtn');
        }

        // Log all relevant elements
        webLogger.console('Modal elements found:', {
            modal: this.modal,
            addButton: addBtn,
            saveButton: document.getElementById('saveScheduleBtn'),
            cancelButton: document.getElementById('cancelScheduleBtn'),
            dayButtons: document.querySelectorAll('.day-btn').length,
            reportCheckboxes: document.querySelectorAll('input[name="report_types"]').length
        });

        this.currentEditId = null;
        this.defaultEmail = null;
        this.initializeEventListeners();

        // Handle period_type and date range
        const periodSelect = document.getElementById('period_type');
        const dateRangeSelection = document.getElementById('dateRangeSelection');
        
        if (periodSelect) {
            periodSelect.addEventListener('change', (e) => {
                if (e.target.value === 'range') {
                    dateRangeSelection.style.display = 'block';
                } else {
                    dateRangeSelection.style.display = 'none';
                }
            });
        }
    }

    initializeEventListeners() {
        this.loadSchedules();
        this.loadDefaultEmail();
        
        // Test Schedule button
        const testBtn = document.getElementById('testScheduleBtn');
        if (testBtn) {
            webLogger.console('✅ Test Schedule button found');
            testBtn.addEventListener('click', () => this.testSchedule());
        }

        // Day buttons
        document.querySelectorAll('.day-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('selected');
            });
        });

        // Modal buttons
        const cancelBtn = document.getElementById('cancelScheduleBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.closeModal());
        }

        const saveBtn = document.getElementById('saveScheduleBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveSchedule());
        }

        // Use default email button
        const useDefaultBtn = document.getElementById('useDefaultEmailBtn');
        if (useDefaultBtn) {
            useDefaultBtn.addEventListener('click', () => {
                const emailInput = document.getElementById('scheduleEmail');
                emailInput.value = this.defaultEmail || '';
            });
        }

        this.initPeriodHandlers();
    }

    async loadDefaultEmail() {
        try {
            const response = await fetch('/api/settings/mail');
            const data = await response.json();
            if (data.success && data.data) {
                this.defaultEmail = data.data.to_email || data.data.from_email;
                // Update the display of the default email
                const defaultEmailDisplay = document.getElementById('defaultEmailDisplay');
                if (defaultEmailDisplay) {
                    defaultEmailDisplay.textContent = this.defaultEmail;
                }
            }
        } catch (error) {
            console.error('Error loading default email:', error);
        }
    }

    initPeriodHandlers() {
        const periodSelect = document.getElementById('schedulePeriod');
        const customRange = document.getElementById('customDateRange');
        
        if (periodSelect) {
            periodSelect.addEventListener('change', (e) => {
                if (e.target.value === 'custom') {
                    customRange.classList.remove('hidden');
                } else {
                    customRange.classList.add('hidden');
                }
            });
        }
    }

    showAddScheduleForm() {
        webLogger.console('🔄 Opening Add Schedule form');
        this.currentEditId = null;
        this.resetForm();
        if (this.modal) {
            this.modal.style.display = 'block';
            webLogger.console('✅ Modal displayed');
        } else {
            console.error('❌ Modal element not found');
        }
    }

    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
        this.resetForm();
    }

    resetForm() {
        // Reset days
        document.querySelectorAll('.day-btn').forEach(btn => {
            btn.classList.remove('selected');
        });

        // Reset time
        document.getElementById('scheduleTime').value = '';

        // Reset report types
        document.querySelectorAll('input[name="report_types"]').forEach(cb => {
            cb.checked = false;
        });
        
        // Reset period type to default "Select Report Period" option
        document.getElementById('period_type').value = '';
        
        // Hide date range selection if it was visible
        document.getElementById('dateRangeSelection').style.display = 'none';
        
        // Reset date range inputs
        document.getElementById('rangeFromDate').value = '';
        document.getElementById('rangeToDate').value = '';
        
        // Reset email field
        document.getElementById('scheduleEmail').value = '';
        
        // Reset error message
        const errorDiv = document.getElementById('scheduleModalError');
        if (errorDiv) {
            errorDiv.style.display = 'none';
            errorDiv.innerHTML = '';
        }
    }

    async saveSchedule() {
        const days = Array.from(document.querySelectorAll('.day-btn.selected'))
            .map(btn => parseInt(btn.dataset.day))
            .sort();

        const time = document.getElementById('scheduleTime').value;
        const reports = Array.from(document.querySelectorAll('input[name="report_types"]:checked'))
            .map(cb => cb.value);
        const periodType = document.getElementById('period_type').value;

        // Validate required fields
        if (!this.validateSchedule(days, time, reports)) {
            return;
        }

        // Base data of the schedule
        const scheduleData = {
            days,
            time,
            reports,
            email: document.getElementById('scheduleEmail').value.trim() || null,
            period_type: periodType
        };

        // Handle date for custom range
        if (periodType === 'range') {
            const fromDate = document.getElementById('rangeFromDate').value;
            const toDate = document.getElementById('rangeToDate').value;
            
            // No need to repeat the validation here, it's already done in validateSchedule
            scheduleData.from_date = fromDate;
            scheduleData.to_date = toDate;
        }

        webLogger.console('📤 Saving schedule with data:', scheduleData);

        try {
            const url = this.currentEditId ? 
                `/api/settings/report/schedules/${this.currentEditId}` :
                '/api/settings/report/schedules';

            webLogger.console(`🔄 Making ${this.currentEditId ? 'PUT' : 'POST'} request to ${url}`);

            const response = await fetch(url, {
                method: this.currentEditId ? 'PUT' : 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(scheduleData)
            });

            const result = await response.json();
            webLogger.console('📥 Server response:', result);

            if (response.ok) {
                await this.loadSchedules();
                this.closeModal();
                showAlert('scheduleStatus', 'Schedule saved successfully', 'success');
                webLogger.console('✅ Schedule saved successfully');
            } else {
                showAlert('scheduleStatus', 'Error saving schedule', 'danger');
                console.error('❌ Error saving schedule:', result.error);
            }
        } catch (error) {
            console.error('❌ Error in save operation:', error);
            showAlert('scheduleStatus', 'Error saving schedule', 'danger');
        }
    }

    validateSchedule(days, time, reports) {
        const period_type = document.getElementById('period_type').value;
        const errorDiv = document.getElementById('scheduleModalError');
        
        // Reset previous error
        errorDiv.style.display = 'none';
        errorDiv.innerHTML = '';

        // Validation days
        if (days.length === 0) {
            errorDiv.innerHTML = 'Please select at least one day';
            errorDiv.style.display = 'block';
            return false;
        }

        // Validation time
        if (!time) {
            errorDiv.innerHTML = 'Please select a time for the schedule';
            errorDiv.style.display = 'block';
            return false;
        }

        // Validation report types
        if (reports.length === 0) {
            errorDiv.innerHTML = 'Please select at least one report type';
            errorDiv.style.display = 'block';
            return false;
        }

        // Validation period
        if (!period_type) {
            errorDiv.innerHTML = 'Please select a report period';
            errorDiv.style.display = 'block';
            return false;
        }
        
        // Validation date in case of custom range
        if (period_type === 'range') {
            const fromDate = document.getElementById('rangeFromDate').value;
            const toDate = document.getElementById('rangeToDate').value;
            
            if (!fromDate || !toDate) {
                errorDiv.innerHTML = 'Please select both From and To dates for custom range';
                errorDiv.style.display = 'block';
                return false;
            }
            
            // Validation date format
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(fromDate) || !dateRegex.test(toDate)) {
                errorDiv.innerHTML = 'Dates must be in YYYY-MM-DD format';
                errorDiv.style.display = 'block';
                return false;
            }
        }

        return true;
    }

    async loadSchedules() {
        try {
            webLogger.console('📥 Fetching schedules from /api/settings/report/schedules');
            const response = await fetch('/api/settings/report/schedules');
            webLogger.console('📥 Raw response:', response);
            const data = await response.json();
            webLogger.console('📥 Parsed response:', data);

            if (data.success) {
                this.schedules = data.data;
                webLogger.console(`✅ Loaded ${this.schedules.length} schedules:`, this.schedules);
                this.renderSchedules();
            } else {
                console.error('❌ Failed to load schedules:', data.message);
            }
        } catch (error) {
            console.error('❌ Error loading schedules:', error);
        }
    }

    renderSchedules() {
        const container = document.getElementById('schedulerList');
        if (!container) return;
        
        if (this.schedules.length === 0) {
            container.innerHTML = '<div class="empty-state">No scheduled reports configured</div>';
            return;
        }
        
        container.innerHTML = this.schedules.map(schedule => `
            <div class="schedule-item" data-schedule-id="${schedule.id}">
                <div class="schedule-info">
                    <div class="schedule-time">
                        <i class="fas fa-clock"></i> ${schedule.time}
                    </div>
                    <div class="schedule-days">
                        <i class="fas fa-calendar"></i> ${this.formatDays(schedule.days)}
                    </div>
                    <div class="schedule-period">
                        <i class="fas fa-calendar-alt"></i> ${this.formatPeriod(schedule)}
                    </div>
                    <div class="schedule-reports">
                        <i class="fas fa-file-alt"></i> ${this.formatReports(schedule.reports)}
                    </div>
                    <div class="schedule-email">
                        <i class="fas fa-envelope"></i> ${schedule.email || '(Default: ' + this.defaultEmail + ')'}
                    </div>
                </div>
                <div class="schedule-actions">
                    <button class="options_btn options_btn_secondary edit-schedule-btn">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="options_btn options_btn_secondary delete-schedule-btn">
                        <i class="fas fa-trash"></i>
                    </button>
                    <label class="schedule-toggle">
                        <input type="checkbox" class="enable-schedule-checkbox" data-schedule-id="${schedule.id}" ${schedule.enabled ? 'checked' : ''}>
                        Enabled
                    </label>
                </div>
            </div>
        `).join('');

        // Add event listeners to the newly created buttons
        container.querySelectorAll('.schedule-item').forEach(item => {
            const scheduleId = parseInt(item.dataset.scheduleId);
            
            item.querySelector('.edit-schedule-btn').addEventListener('click', () => {
                this.editSchedule(scheduleId);
            });
            
            item.querySelector('.delete-schedule-btn').addEventListener('click', () => {
                this.deleteSchedule(scheduleId);
            });
        });

        // Add event listeners to the schedule toggle checkboxes
        container.querySelectorAll('.enable-schedule-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', function() {
                const scheduleId = parseInt(this.dataset.scheduleId);
                const newStatus = this.checked;

                // Send a request to update the schedule's enabled flag
                fetch(`/api/settings/report/schedules/${scheduleId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: newStatus })
                })
                .then(resp => resp.json())
                .then(data => {
                    if (data.success) {
                        showAlert('scheduleStatus', `Schedule ${newStatus ? 'enabled' : 'disabled'} successfully`, 'success');
                    } else {
                        showAlert('scheduleStatus', 'Error updating schedule status', 'danger');
                        this.checked = !newStatus; // Revert in case of error
                    }
                })
                .catch(error => {
                    console.error('Error updating schedule status:', error);
                    showAlert('scheduleStatus', 'Error updating schedule status', 'danger');
                    this.checked = !newStatus;
                });
            });
        });
    }

    async editSchedule(id) {
        try {
            webLogger.console(`🔄 Editing schedule ${id}`);
            const schedule = this.schedules.find(s => s.id === id);
            if (!schedule) {
                console.error(`❌ Schedule ${id} not found`);
                return;
            }

            webLogger.console('📝 Schedule data:', schedule);
            this.currentEditId = id;
            this.resetForm();
            
            // Populate form
            document.querySelectorAll('.day-btn').forEach(btn => {
                const day = parseInt(btn.dataset.day);
                if (schedule.days.includes(day)) {
                    btn.classList.add('selected');
                }
            });
            
            document.getElementById('scheduleTime').value = schedule.time;
            document.querySelectorAll('input[name="report_types"]').forEach(cb => {
                cb.checked = schedule.reports.includes(cb.value);
            });
            
            // Set period type
            const periodTypeSelect = document.getElementById('period_type');
            periodTypeSelect.value = schedule.period_type || '';
            
            // Handle date range if needed
            if (schedule.period_type === 'range') {
                document.getElementById('dateRangeSelection').style.display = 'block';
                if (schedule.from_date) {
                    document.getElementById('rangeFromDate').value = schedule.from_date.substring(0, 10); // Get YYYY-MM-DD part
                }
                if (schedule.to_date) {
                    document.getElementById('rangeToDate').value = schedule.to_date.substring(0, 10); // Get YYYY-MM-DD part
                }
            }
            
            const emailInput = document.getElementById('scheduleEmail');
            emailInput.value = schedule.email || this.defaultEmail || '';
            
            this.modal.style.display = 'block';
            webLogger.console('✅ Edit form populated and displayed');
            
        } catch (error) {
            console.error('❌ Error in edit operation:', error);
            showAlert('scheduleStatus', 'Error editing schedule', 'danger');
        }
    }

    async deleteSchedule(id) {
        webLogger.console(`🗑️ Attempting to delete schedule ${id}`);
        if (!confirm('Are you sure you want to delete this schedule?')) {
            webLogger.console('❌ Delete cancelled by user');
            return;
        }
        
        try {
            webLogger.console(`🔄 Sending DELETE request for schedule ${id}`);
            const response = await fetch(`/api/settings/report/schedules/${id}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                webLogger.console('✅ Schedule deleted successfully');
                await this.loadSchedules();
                showAlert('scheduleStatus', 'Schedule deleted successfully', 'success');
            }
        } catch (error) {
            console.error('❌ Error deleting schedule:', error);
            showAlert('scheduleStatus', 'Error deleting schedule', 'danger');
        }
    }

    formatDays(days) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return days.map(d => dayNames[d]).join(', ');
    }

    formatReports(reports) {
        return reports.join(', ');
    }

    formatPeriod(schedule) {
        switch(schedule.period_type) {
            case 'daily': return 'Last 24 hours';
            case 'weekly': return 'Last 7 days';
            case 'monthly': return 'Last 30 days';
            case 'custom': return `${schedule.from_date} to ${schedule.to_date}`;
            default: return schedule.period_type;
        }
    }

    async testSchedule() {
        webLogger.console('🧪 Testing schedule...');
        const testBtn = document.getElementById('testScheduleBtn');
        const originalContent = testBtn.innerHTML;
        
        const days = Array.from(document.querySelectorAll('.day-btn.selected'))
            .map(btn => parseInt(btn.dataset.day))
            .sort();
        const time = document.getElementById('scheduleTime').value;
        const reports = Array.from(document.querySelectorAll('input[name="report_types"]:checked'))
            .map(cb => cb.value);
        const periodType = document.getElementById('period_type').value;
        const errorDiv = document.getElementById('scheduleModalError');
        
        // Reset previous error
        errorDiv.style.display = 'none';
        errorDiv.innerHTML = '';
        
        // Minimum validation for the test: Report Types and Report Period
        if (reports.length === 0) {
            errorDiv.innerHTML = 'Please select at least one report type';
            errorDiv.style.display = 'block';
            return;
        }
        
        if (!periodType) {
            errorDiv.innerHTML = 'Please select a report period';
            errorDiv.style.display = 'block';
            return;
        }
        
        // If the period type is 'range', verify that the dates are specified
        if (periodType === 'range') {
            const fromDate = document.getElementById('rangeFromDate').value;
            const toDate = document.getElementById('rangeToDate').value;
            
            if (!fromDate || !toDate) {
                errorDiv.innerHTML = 'Please select both From and To dates for custom range';
                errorDiv.style.display = 'block';
                return;
            }
            
            // Validation date format
            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(fromDate) || !dateRegex.test(toDate)) {
                errorDiv.innerHTML = 'Dates must be in YYYY-MM-DD format';
                errorDiv.style.display = 'block';
                return;
            }
        }
        
        // Disable the button and show the animation
        testBtn.disabled = true;
        testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';

        const scheduleData = {
            days: days,
            time: time,
            reports: reports,
            email: document.getElementById('scheduleEmail').value.trim() || null,
            period_type: periodType
        };
        
        // Add from_date and to_date when period_type is 'range'
        if (scheduleData.period_type === 'range') {
            scheduleData.from_date = document.getElementById('rangeFromDate').value;
            scheduleData.to_date = document.getElementById('rangeToDate').value;
        }

        webLogger.console('📤 Test data:', scheduleData);

        try {
            const response = await fetch('/api/settings/report/schedules/test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(scheduleData)
            });

            const result = await response.json();
            webLogger.console('📥 Test response:', result);

            if (result && result.success) {
                showAlert('scheduleStatus', 'Schedule test successful', 'success');
            } else {
                showAlert('scheduleStatus', 'Schedule test failed: ' + result.message, 'danger');
            }
        } catch (error) {
            console.error('❌ Error testing schedule:', error);
            showAlert('scheduleStatus', 'Error testing schedule', 'danger');
        } finally {
            // Restore the button to the original state
            testBtn.disabled = false;
            testBtn.innerHTML = originalContent;
        }
    }
}

// Add the event listener for the Cancel button
document.getElementById('cancelScheduleBtn').addEventListener('click', function() {
    document.getElementById('scheduleModal').style.display = 'none';
});

// Remove the duplicate declaration of TimezonedPage and modify OptionsPage
class OptionsPage extends BasePage {
    constructor() {
        super();
        this.emailConfigured = false;
        this.initializeNotificationControls();
        this.initializeTabs();
        this.initSendReportNow();
    }

    initializeNotificationControls() {
        const enabledCheckbox = document.getElementById('enabled');
        const warningDiv = document.getElementById('email_config_warning');
        const dependentSections = document.getElementById('notification_dependent_sections');

        // Check if the email is configured
        this.checkEmailConfiguration().then(configured => {
            this.emailConfigured = configured;
            enabledCheckbox.disabled = !configured;
            warningDiv.classList.toggle('hidden', configured);

            if (configured && enabledCheckbox.checked) {
                dependentSections.classList.remove('hidden');
            } else {
                dependentSections.classList.add('hidden');
            }
        });

        // Event listener for the checkbox
        enabledCheckbox.addEventListener('change', (e) => {
            if (!this.emailConfigured) {
                e.preventDefault();
                e.target.checked = false;
                this.showAlert('options_nutify_status', 'Please configure email settings first', 'warning');
                return;
            }

            dependentSections.classList.toggle('hidden', !e.target.checked);
        });
    }

    async checkEmailConfiguration() {
        try {
            const response = await fetch('/api/settings/mail');
            const data = await response.json();
            return data.success && data.data && 
                   data.data.smtp_server && 
                   data.data.smtp_port && 
                   data.data.from_email;
        } catch (error) {
            console.error('Error checking email configuration:', error);
            return false;
        }
    }

    initializeTabs() {
        const tabButtons = document.querySelectorAll('.options_tab_button');
        const tabContents = document.querySelectorAll('.options_tab_content');

        // Function to activate a tab
        const activateTab = (tabId) => {
            // Remove active from all buttons and contents
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));

            // Activate the selected tab
            const selectedButton = document.querySelector(`[data-tab="${tabId}"]`);
            const selectedContent = document.getElementById(`${tabId}_tab`);

            if (selectedButton && selectedContent) {
                selectedButton.classList.add('active');
                selectedContent.classList.add('active');
            }
        };

        // Add event listener for each button
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const tabId = button.getAttribute('data-tab');
                activateTab(tabId);
            });
        });
    }

    initSendReportNow() {
        const sendReportBtn = document.getElementById('sendReportNow');
        if (sendReportBtn) {
            sendReportBtn.addEventListener('click', async () => {
                // Collect the data from the checkboxes in the Report Settings section
                const reports = Array.from(document.querySelectorAll('#notifications_tab .options_notification_form input[name="report_types"]:checked'))
                    .map(cb => cb.value);
                
                if (reports.length === 0) {
                    // Temporarily change the button text to show the error
                    const originalContent = sendReportBtn.innerHTML;
                    sendReportBtn.innerHTML = '<i class="fas fa-exclamation-circle"></i> Select Reports!';
                    sendReportBtn.classList.add('btn-error');
                    
                    // Restore the button after 2 seconds
                    setTimeout(() => {
                        sendReportBtn.innerHTML = originalContent;
                        sendReportBtn.classList.remove('btn-error');
                    }, 2000);
                    return;
                }
                
                // Get the dates
                const fromDate = document.getElementById('report_from_date').value;
                const toDate = document.getElementById('report_to_date').value;
                
                if (!fromDate || !toDate) {
                    // Temporarily change the button text to show the error
                    const originalContent = sendReportBtn.innerHTML;
                    sendReportBtn.innerHTML = '<i class="fas fa-exclamation-circle"></i> Select Dates!';
                    sendReportBtn.classList.add('btn-error');
                    
                    // Restore the button after 2 seconds
                    setTimeout(() => {
                        sendReportBtn.innerHTML = originalContent;
                        sendReportBtn.classList.remove('btn-error');
                    }, 2000);
                    return;
                }
                
                // Disable the button during the sending
                sendReportBtn.disabled = true;
                const originalContent = sendReportBtn.innerHTML;
                sendReportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
                
                // Prepare the data for the API
                const testData = {
                    reports,
                    period_type: 'range',
                    from_date: fromDate,
                    to_date: toDate
                };
                
                let success = false;
                
                try {
                    // Perform the request with improved error handling
                    let response;
                    try {
                        response = await fetch('/api/settings/report/schedules/test', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(testData)
                        });
                    } catch (fetchError) {
                        console.error('Network error:', fetchError);
                        throw new Error('Network error');
                    }
                    
                    // Verify if the response is OK
                    if (!response.ok) {
                        console.error('Server error:', response.status, response.statusText);
                        throw new Error(`Server error: ${response.status}`);
                    }
                    
                    // Get the response first as text and then try to parse it as JSON
                    let result;
                    try {
                        const text = await response.text();
                        webLogger.console('Raw response text:', text.substring(0, 100)); // Log only the first 100 characters
                        
                        if (!text || text.trim() === '') {
                            console.warn('Empty response from server');
                            result = { success: false, message: 'Empty response' };
                        } else {
                            result = JSON.parse(text);
                        }
                    } catch (parseError) {
                        console.error('Error parsing JSON response:', parseError);
                        throw new Error('Invalid response format');
                    }
                    
                    webLogger.console('API Response:', result);
                    
                    if (result && result.success) {
                        success = true;
                    } else {
                        console.error('API reported failure:', result.message || 'Unknown error');
                    }
                } catch (error) {
                    console.error('Error sending report:', error);
                } finally {
                    // Re-enable the button
                    sendReportBtn.disabled = false;
                    
                    if (success) {
                        // Show success message in the button
                        sendReportBtn.innerHTML = '<i class="fas fa-check-circle"></i> Report Sent!';
                        sendReportBtn.classList.add('btn-success');
                    } else {
                        // Show error message in the button
                        sendReportBtn.innerHTML = '<i class="fas fa-times-circle"></i> Failed to Send!';
                        sendReportBtn.classList.add('btn-error');
                    }
                    
                    // Restore the button after 2 seconds
                    setTimeout(() => {
                        sendReportBtn.innerHTML = originalContent;
                        sendReportBtn.classList.remove('btn-success', 'btn-error');
                    }, 2000);
                }
            });
        }
    }
}

// Initialize OptionsPage once the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    const page = new OptionsPage();
    
    // Handling of the test buttons for notifications
    document.querySelectorAll('.options_nutify_test').forEach(button => {
        button.addEventListener('click', async function() {
            const eventType = this.dataset.eventType;
            const originalContent = button.innerHTML;
            
            try {
                button.disabled = true;
                button.innerHTML = `<span class="button-loader"><i class="fas fa-spinner fa-spin"></i> Testing...</span>`;
                
                // Collect form data for testing email
                const formData = new FormData(document.getElementById('emailConfigForm'));
                const config = {};
                formData.forEach((value, key) => {
                    if (key === 'enabled') {
                        config[key] = true;
                    } else if (key === 'password' && !value) {
                        // If empty, use the one already present
                    } else {
                        config[key] = value;
                    }
                });

                // Add the parameters for the notification test
                config.event_type = eventType;
                config.test_type = 'notification';

                const response = await fetch('/api/settings/mail/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });

                const data = await response.json();
                if (data.success) {
                    showNotifyAlert('Test notification sent successfully', 'success');
                } else {
                    showNotifyAlert('Error sending test notification: ' + data.message, 'danger');
                }
            } catch (error) {
                console.error('Error:', error);
                showNotifyAlert('Error sending test notification', 'danger');
            } finally {
                button.disabled = false;
                button.innerHTML = originalContent;
            }
        });
    });
});

// Add a global handler for JSON parsing errors
window.addEventListener('unhandledrejection', function(event) {
    if (event.reason instanceof SyntaxError && event.reason.message.includes('JSON.parse')) {
        console.error('JSON parsing error, response might not be valid JSON:', event.reason);
    }
});

// Email provider configurations
const emailProviders = {
    gmail: {
        smtp_server: 'smtp.gmail.com',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    },
    outlook: {
        smtp_server: 'smtp.office365.com',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    },
    icloud: {
        smtp_server: 'smtp.mail.me.com',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    },
    yahoo: {
        smtp_server: 'smtp.mail.yahoo.com',
        smtp_port: 465,
        tls: true,
        tls_starttls: false,
        auth: true
    },
    amazon: {
        smtp_server: 'email-smtp.us-east-1.amazonaws.com',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    },
    sendgrid: {
        smtp_server: 'smtp.sendgrid.net',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    },
    mailgun: {
        smtp_server: 'smtp.mailgun.org',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    },
    postmark: {
        smtp_server: 'smtp.postmarkapp.com',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    },
    zoho: {
        smtp_server: 'smtp.zoho.com',
        smtp_port: 587,
        tls: true,
        tls_starttls: true,
        auth: true
    }
};

// Function to configure fields based on provider
function configureEmailProvider(provider) {
    const config = emailProviders[provider];
    if (config) {
        document.getElementById('smtp_server').value = config.smtp_server;
        document.getElementById('smtp_port').value = config.smtp_port;
        
        // Clear other fields to ensure user enters their own credentials
        document.getElementById('from_name').value = '';
        document.getElementById('from_email').value = '';
        document.getElementById('username').value = '';
        document.getElementById('password').value = '';
        
        // Hide the save button until test is successful
        document.getElementById('saveConfigBtn').classList.add('hidden');
    }
}

// Add event listener for provider selection
document.getElementById('email_provider').addEventListener('change', function() {
    const provider = this.value;
    if (provider) {
        configureEmailProvider(provider);
    } else {
        // Clear all fields for custom configuration
        clearFormFields();
    }
});