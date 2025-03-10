// Logger for the UPS commands page
const logger = {
    data: (...args) => webLogger.data('[UPSCmd Page]', ...args),
    error: (...args) => webLogger.error('[UPSCmd Page]', ...args),
    event: (...args) => webLogger.event('[UPSCmd Page]', ...args),
    page: (...args) => webLogger.page('[UPSCmd Page]', ...args)
};

// Icon mapping for commands
const COMMAND_ICONS = {
    'beeper.enable': 'fa-volume-up',
    'beeper.disable': 'fa-volume-mute',
    'beeper.toggle': 'fa-volume-down',
    'beeper.mute': 'fa-volume-mute',
    'beeper.off': 'fa-volume-mute',
    'beeper.on': 'fa-volume-up',
    
    'test.battery.start': 'fa-play',
    'test.battery.stop': 'fa-stop',
    'test.battery.start.deep': 'fa-car-battery',
    'test.battery.start.quick': 'fa-bolt',
    'test.panel.start': 'fa-tv',
    'test.panel.stop': 'fa-tv',
    
    'shutdown.return': 'fa-power-off',
    'shutdown.stayoff': 'fa-plug',
    'shutdown.stop': 'fa-stop-circle',
    'shutdown.reboot': 'fa-sync',
    'shutdown.reboot.graceful': 'fa-redo',
    
    'load.off': 'fa-toggle-off',
    'load.on': 'fa-toggle-on',
    'load.off.delay': 'fa-clock',
    'load.on.delay': 'fa-clock',
    
    'outlet.1.load.off': 'fa-plug',
    'outlet.1.load.on': 'fa-plug',
    'outlet.2.load.off': 'fa-plug',
    'outlet.2.load.on': 'fa-plug',
    
    'calibrate.start': 'fa-chart-line',
    'calibrate.stop': 'fa-stop',
    
    'reset.input.minmax': 'fa-undo',
    'reset.watchdog': 'fa-sync',
    
    'bypass.start': 'fa-random',
    'bypass.stop': 'fa-random'
};

// SOCKET INIT
class SocketManager {
    constructor() {
        logger.page('🔌 Socket Manager Initialization');
        this.socket = io();
        this.initializeSocketEvents();
    }

    initializeSocketEvents() {
        // Connection handling
        this.socket.on('connect', () => {
            logger.event('🔌 WebSocket Connected - ID:', this.socket.id);
            document.querySelector('.socket_connected').classList.remove('hidden');
            document.querySelector('.socket_disconnected').classList.add('hidden');
            document.body.classList.add('socket-connected');
        });

        this.socket.on('disconnect', () => {
            logger.event('🔌 WebSocket Disconnected');
            document.querySelector('.socket_connected').classList.add('hidden');
            document.querySelector('.socket_disconnected').classList.remove('hidden');
            document.body.classList.remove('socket-connected');
        });

        this.socket.on('connect_error', (error) => {
            logger.error('🔌 WebSocket Error:', error);
        });

        // Command events
        this.socket.on('command_stats_update', (stats) => {
            logger.data('📊 [WebSocket] Received statistics:', stats);
            document.getElementById('totalCommands').textContent = stats.total;
            document.getElementById('successfulCommands').textContent = stats.successful;
            document.getElementById('failedCommands').textContent = stats.failed;
        });

        this.socket.on('command_logs_update', (logs) => {
            logger.data('📝 [WebSocket] Received logs:', logs.length + ' entries');
            this.updateLogs(logs);
        });

        this.socket.on('command_executed', (data) => {
            logger.event('⚡ [WebSocket] Command executed:', {
                command: data.command,
                success: data.success,
                output: data.output
            });
            this.handleCommandExecution(data);
        });
    }

    updateLogs(logs) {
        const logContainer = document.getElementById('commandLog');
        if (!logContainer) return;

        logContainer.innerHTML = logs.map(entry => `
            <div class="log-entry ${entry.success ? 'log-success' : 'log-error'}">
                <div class="log-time">${new Date(entry.timestamp).toLocaleString()}</div>
                <div class="log-content">
                    <div class="log-command">
                        <strong>${entry.command}</strong>
                        <span class="log-status ${entry.success ? 'text-success' : 'text-danger'}">
                            [${entry.success ? 'Success' : 'Error'}]
                        </span>
                    </div>
                    ${entry.output ? `<div class="log-details">${entry.output}</div>` : ''}
                </div>
            </div>
        `).join('');
    }

    handleCommandExecution(data) {
        logger.event('⚡ [WebSocket] Command result handling:', {
            command: data.command,
            success: data.success
        });
        
        // Update the confirmation modal with the result
        const modalBody = document.getElementById('modalBody');
        if (modalBody) {
            const output = typeof data.output === 'object' ? 
                JSON.stringify(data.output, null, 2) : 
                data.output;
            
            modalBody.innerHTML = `
                <div class="command-execution-status">
                    <div class="mb-2">
                        <i class="fas fa-${data.success ? 'check' : 'times'}-circle 
                           ${data.success ? 'text-success' : 'text-danger'}"></i> 
                        ${data.success ? 'Command executed successfully' : 'Error in execution'}
                    </div>
                    ${output ? `
                        <div class="live-log p-2 bg-light">
                            ${output}
                        </div>
                    ` : ''}
                </div>
            `;
        }
    }
}
// SOCKET END

// CONTROLLER INIT
class UPSCommandPage extends BasePage {
    constructor() {
        super();
        logger.page('UPS Commands page initialization');
        
        // DOM elements
        this.elements = {
            commandsList: document.getElementById('commandsList'),
            refreshButton: document.getElementById('refreshCommands'),
            clearStatsButton: document.getElementById('clearStats'),
            clearLogsButton: document.getElementById('clearLogs'),
            confirmModal: document.getElementById('confirmModal'),
            clearModal: document.getElementById('clearConfirmModal'),
            infoModal: document.getElementById('infoModal'),
            clearTypeSpan: document.getElementById('clearType'),
            confirmClearButton: document.getElementById('confirmClear'),
            confirmButton: document.getElementById('confirmCommand'),
            modalLabel: document.getElementById('confirmModalLabel'),
            modalBody: document.getElementById('modalBody'),
            infoTitle: document.getElementById('infoTitle'),
            infoDescription: document.getElementById('infoDescription'),
            infoWarning: document.getElementById('infoWarning')
        };
        
        // State
        this.state = {
            currentCommand: null,
            clearType: null,
            isExecuting: false
        };
        
        // Command details
        this.commandDetails = {
            // Beeper commands
            'beeper.disable': {
                title: 'Disable Beeper',
                description: 'Permanently disables the UPS beeper.',
                warning: 'The beeper will remain disabled until manually re-enabled.'
            },
            'beeper.enable': {
                title: 'Enable Beeper',
                description: 'Enables the UPS beeper.',
                warning: 'Restores the normal beeper functionality.'
            },
            'beeper.toggle': {
                title: 'Toggle Beeper',
                description: 'Toggles the UPS beeper between active and inactive.',
                warning: 'Alternates the beeper status between active and inactive.'
            },
            'beeper.mute': {
                title: 'Mute Beeper',
                description: 'Silences the UPS beeper temporarily.',
                warning: 'The beeper may automatically reactivate in case of new events.'
            },

            // Load Commands
            'load.off': {
                title: 'Immediate Shutdown',
                description: 'Turns off the power to all connected devices immediately.',
                warning: 'ATTENTION: Immediate power interruption! May cause data loss.'
            },
            'load.on': {
                title: 'Immediate Power On',
                description: 'Restores the power to all connected devices immediately.',
                warning: 'Verify that the devices can be safely powered on.'
            },
            'load.off.delay': {
                title: 'Delayed Shutdown',
                description: 'Turns off the power to all connected devices after a configured delay.',
                warning: 'The power will be interrupted at the end of the configured delay.'
            },
            'load.on.delay': {
                title: 'Delayed Power On',
                description: 'Restores the power to all connected devices after a configured delay.',
                warning: 'The power will be restored at the end of the configured delay.'
            },

            // Outlet Commands
            'outlet.1.load.off': {
                title: 'Turn Off Outlet 1',
                description: 'Turns off the power to outlet 1.',
                warning: 'Interrupts the power only to the specified outlet.'
            },
            'outlet.1.load.on': {
                title: 'Turn On Outlet 1',
                description: 'Turns on the power to outlet 1.',
                warning: 'Restores the power only to the specified outlet.'
            },
            'outlet.2.load.off': {
                title: 'Turn Off Outlet 2',
                description: 'Turns off the power to outlet 2.',
                warning: 'Interrupts the power only to the specified outlet.'
            },
            'outlet.2.load.on': {
                title: 'Turn On Outlet 2',
                description: 'Turns on the power to outlet 2.',
                warning: 'Restores the power only to the specified outlet.'
            },

            // Shutdown Commands
            'shutdown.return': {
                title: 'Shutdown with Return',
                description: 'Turns off the UPS and reactivates when the network power returns.',
                warning: 'The systems will automatically restart when the power returns.'
            },
            'shutdown.stayoff': {
                title: 'Shutdown with Return',
                description: 'Turns off the UPS and reactivates when the network power returns.',
                warning: 'The systems will automatically restart when the power returns.'
            },
            'shutdown.stop': {
                title: 'Stop Shutdown',
                description: 'Cancels a shutdown in progress.',
                warning: 'Ensure the interruption is safe for the connected systems.'
            },
            'shutdown.reboot': {
                title: 'Full Reboot',
                description: 'Performs a complete cycle of shutdown and restart.',
                warning: 'All connected systems will be restarted.'
            },
            'shutdown.reboot.graceful': {
                title: 'Graceful Reboot',
                description: 'Performs a controlled restart with a shutdown of the systems.',
                warning: 'Waits for the correct shutdown of the systems before the restart.'
            },

            // Battery Test Commands
            'test.battery.start': {
                title: 'Standard Battery Test',
                description: 'Starts a complete battery test.',
                warning: 'The test may take several minutes.'
            },
            'test.battery.start.deep': {
                title: 'Deep Battery Test',
                description: 'Performs a deep battery test with a complete discharge/charge cycle.',
                warning: 'ATTENTION: Long test that significantly discharges the battery!'
            },
            'test.battery.start.quick': {
                title: 'Quick Battery Test',
                description: 'Performs a quick battery test.',
                warning: 'Basic test for routine checks.'
            },
            'test.battery.stop': {
                title: 'Stop Battery Test',
                description: 'Stops any ongoing battery test.',
                warning: 'The interruption will provide incomplete results.'
            },

            // Calibration Commands
            'calibrate.start': {
                title: 'Start Calibration',
                description: 'Starts the calibration procedure.',
                warning: 'The calibration requires a complete discharge cycle.'
            },
            'calibrate.stop': {
                title: 'Stop Calibration',
                description: 'Stops the ongoing calibration procedure.',
                warning: 'The interruption will invalidate the calibration.'
            },

            // Reset Commands
            'reset.input.minmax': {
                title: 'Reset Input Min/Max',
                description: 'Resets the recorded minimum and maximum values for the input.',
                warning: 'The historical data of the extreme values will be deleted.'
            },
            'reset.watchdog': {
                title: 'Reset Watchdog',
                description: 'Resets the watchdog timer of the UPS.',
                warning: 'May affect automatic monitoring functions.'
            },

            // Comandi di Sistema
            'bypass.start': {
                title: 'Activate Bypass',
                description: 'Activates the bypass mode of the UPS.',
                warning: 'The power will pass directly from the network to the devices.'
            },
            'bypass.stop': {
                title: 'Deactivate Bypass',
                description: 'Deactivates the bypass mode of the UPS.',
                warning: 'The power will return to pass through the UPS.'
            }
        };
        
        // Initialize socket and event listeners
        this.socketManager = new SocketManager();
        this.initializeEventListeners();
        this.loadCommands();
        
        // Hide all modals at startup
        this.hideAllModals();
    }
    
    hideAllModals() {
        const modals = document.querySelectorAll('.modal');
        modals.forEach(modal => modal.style.display = 'none');
    }
    
    initializeEventListeners() {
        // Refresh button
        this.elements.refreshButton?.addEventListener('click', () => {
            logger.event('Click on Refresh');
            this.loadCommands();
        });
        
        // Clear logs button
        this.elements.clearLogsButton?.addEventListener('click', () => {
            logger.event('Click on Clear Logs');
            this.showClearConfirmation();
        });
        
        // Confirm buttons
        this.elements.confirmClearButton?.addEventListener('click', () => {
            logger.event('Click on Confirm Clear');
            this.executeClear();
        });
        
        this.elements.confirmButton?.addEventListener('click', () => {
            logger.event('Click on Execute in the modal');
            this.executeCurrentCommand();
        });
        
        // Modal close buttons
        document.querySelectorAll('.modal-close').forEach(button => {
            button.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) this.hideModal(modal);
            });
        });
        
        // Click outside modal
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.hideModal(modal);
            });
        });
    }
    
    async loadCommands() {
        try {
            logger.data('Loading commands list...');
            const response = await fetch('/api/upscmd/list');
            const data = await response.json();
            
            if (data.success) {
                logger.data('Commands loaded successfully:', data.commands);
                
                this.elements.commandsList.innerHTML = '';
                
                data.commands.forEach(cmd => {
                    const details = this.commandDetails[cmd.name] || {
                        title: cmd.name,
                        description: cmd.description,
                        warning: 'Be careful in executing this command.'
                    };
                    
                    const commandDiv = document.createElement('div');
                    commandDiv.className = 'stat_card';
                    const iconClass = COMMAND_ICONS[cmd.name] || 'fa-terminal';
                    
                    commandDiv.innerHTML = `
                        <div class="stat-icon">
                            <i class="fas ${iconClass}"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-header">
                                <span class="stat-label">${details.title}</span>
                            </div>
                            <p class="stat-description">${details.description}</p>
                            <div class="stat-actions">
                                <div class="button-group">
                                    <button class="btn-primary btn-small info-button" data-command="${cmd.name}">
                                        <i class="fas fa-info-circle"></i>
                                    </button>
                                    <button class="btn-primary execute-button" data-command="${cmd.name}">
                                        Execute
                                    </button>
                                </div>
                            </div>
                        </div>
                    `;
                    
                    this.elements.commandsList.appendChild(commandDiv);
                });

                this.attachCommandListeners();
            }
        } catch (error) {
            logger.error('Error loading commands:', error);
        }
    }
    
    showCommandConfirmation(commandName, details) {
        if (this.state.isExecuting) {
            logger.event('Command already in execution, ignoring request');
            return;
        }

        this.state.currentCommand = commandName;
        
        this.elements.modalLabel.textContent = details.title;
        this.elements.modalBody.innerHTML = `
            <div class="command-confirmation">
                <p>${details.description}</p>
                <div class="command-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>${details.warning}</p>
                </div>
                <p class="command-execute-confirm">Are you sure you want to execute this command?</p>
            </div>
        `;

        this.elements.confirmButton.disabled = false;
        this.elements.confirmButton.innerHTML = 'Execute';
        this.elements.confirmButton.style.display = 'block';

        this.showModal(this.elements.confirmModal);
    }
    
    showCommandInfo(commandName, details) {
        this.elements.infoTitle.textContent = details.title;
        this.elements.infoDescription.textContent = details.description;
        this.elements.infoWarning.textContent = details.warning;
        this.showModal(this.elements.infoModal);
    }
    
    showClearConfirmation() {
        this.showModal(this.elements.clearModal);
    }
    
    async executeClear() {
        try {
            const response = await fetch('/api/upscmd/clear/logs', {
                method: 'POST'
            });
            
            const data = await response.json();
            
            if (data.success) {
                // Reset both logs and stats
                document.getElementById('commandLog').innerHTML = '';
                this.updateStats({ total: 0, successful: 0, failed: 0 });
            } else {
                throw new Error(data.error);
            }
            
        } catch (error) {
            logger.error(`Error in clearing: ${error}`);
            alert(`Error in clearing: ${error.message}`);
        } finally {
            this.hideModal(this.elements.clearModal);
        }
    }
    
    async executeCurrentCommand() {
        if (!this.state.currentCommand || this.state.isExecuting) return;

        this.state.isExecuting = true;
        this.elements.confirmButton.disabled = true;
        this.elements.confirmButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> In execution...';

        try {
            const response = await fetch('/api/upscmd/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: this.state.currentCommand })
            });

            const data = await response.json();

            if (data.success) {
                // Ensure the output is a string
                const output = typeof data.output === 'object' ? 
                    JSON.stringify(data.output) : String(data.output);
                this.showCommandResult(true, output);
                await this.loadCommands();
            } else {
                throw new Error(String(data.error));
            }

        } catch (error) {
            this.showCommandResult(false, String(error.message));
        } finally {
            this.state.isExecuting = false;
            this.elements.confirmButton.disabled = false;
            this.elements.confirmButton.innerHTML = 'Execute';
        }
    }
    
    showCommandResult(success, output) {
        // Ensure the output is a string
        const safeOutput = String(output);
        
        this.elements.modalBody.innerHTML = `
            <div class="command-execution-status">
                <div class="mb-2">
                    <i class="fas fa-${success ? 'check' : 'times'}-circle 
                       ${success ? 'text-success' : 'text-danger'}"></i> 
                    ${success ? 'Command executed successfully' : 'Error in execution'}
                </div>
                ${safeOutput ? `
                    <div class="live-log p-2 bg-light">
                        ${safeOutput}
                    </div>
                ` : ''}
            </div>
        `;
        this.elements.confirmButton.style.display = 'none';
        if (success && !this.state.currentCommand.startsWith('test.')) {
            setTimeout(() => this.hideModal(this.elements.confirmModal), 5000);
        }
    }

    formatCommandOutput(output) {
        if (!output) return '';
        return output.split('\n').map(line => {
            if (line.toLowerCase().includes('error')) {
                return `<span class="text-danger">${line}</span>`;
            }
            if (line.toLowerCase().includes('ups.status:')) {
                return `<strong class="text-primary">${line}</strong>`;
            }
            if (line.toLowerCase().includes('ups.test.result:')) {
                return `<strong class="text-success">${line}</strong>`;
            }
            if (line.toLowerCase().includes('battery.')) {
                return `<span class="text-info">${line}</span>`;
            }
            return line;
        }).join('<br>');
    }

    showModal(modal) {
        if (modal) modal.style.display = 'block';
    }

    hideModal(modal) {
        if (modal) {
            modal.style.display = 'none';
            this.state.isExecuting = false;
            this.state.currentCommand = null;
        }
    }

    updateStats(stats) {
        document.getElementById('totalCommands').textContent = stats.total;
        document.getElementById('successfulCommands').textContent = stats.successful;
        document.getElementById('failedCommands').textContent = stats.failed;
    }

    getGroupTitle(type) {
        const titles = {
            beeper: 'Beeper Control',
            test: 'Battery Test',
            shutdown: 'Shutdown Commands',
            load: 'Load Control',
            outlet: 'Outlet Control',
            calibrate: 'Calibration',
            reset: 'Reset',
            bypass: 'Bypass'
        };
        return titles[type] || (type.charAt(0).toUpperCase() + type.slice(1));
    }

    attachCommandListeners() {
        // Event delegation for buttons
        this.elements.commandsList.addEventListener('click', (e) => {
            const executeButton = e.target.closest('.execute-button');
            const infoButton = e.target.closest('.info-button');
            
            if (executeButton) {
                e.preventDefault();
                const commandName = executeButton.getAttribute('data-command');
                const details = this.commandDetails[commandName] || {
                    title: commandName,
                    description: "UPS Command",
                    warning: 'Be careful in executing this command.'
                };
                this.showCommandConfirmation(commandName, details);
            }
            
            if (infoButton) {
                e.preventDefault();
                const commandName = infoButton.getAttribute('data-command');
                const details = this.commandDetails[commandName] || {
                    title: commandName,
                    description: "UPS Command",
                    warning: 'Be careful in executing this command.'
                };
                this.showCommandInfo(commandName, details);
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    logger.page('DOM loaded, page initialization');
    webLogger.enable(false);
    new UPSCommandPage();
});