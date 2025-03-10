// Check if TimezonedPage is already defined; if not, define it.
if (typeof window.TimezonedPage === 'undefined') {
    class TimezonedPage {
        getConfiguredTimezone() {
            webLogger.console("DEBUG: Checking meta tag...");
            // Try reading the timezone from the meta tag first
            const metaTag = document.querySelector('meta[name="timezone"]');
            webLogger.console("DEBUG: Meta tag found:", metaTag);
            if (metaTag && metaTag.content) {
                webLogger.console("DEBUG: Meta tag content:", metaTag.content);
                return metaTag.content;
            }
            webLogger.console("DEBUG: Checking APP_CONFIG...");
            // If not found, try using APP_CONFIG
            if (window.APP_CONFIG && window.APP_CONFIG.timezone) {
                webLogger.console("DEBUG: APP_CONFIG timezone:", window.APP_CONFIG.timezone);
                return window.APP_CONFIG.timezone;
            }
            webLogger.console("DEBUG: No timezone found in either source");
            webLogger.error('Timezone configuration not found (neither meta tag nor APP_CONFIG)');
            throw new Error('Timezone configuration is required');
        }
    }
    window.TimezonedPage = TimezonedPage;
}

// Logger for the UPS variables page
const logger = {
    data: (...args) => webLogger.data('[UPSrw Page]', ...args),
    error: (...args) => webLogger.error('[UPSrw Page]', ...args),
    event: (...args) => webLogger.event('[UPSrw Page]', ...args),
    page: (...args) => webLogger.page('[UPSrw Page]', ...args)
};

// SOCKET START
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

        // Variable events
        this.socket.on('variable_update', (data) => {
            logger.data('📊 [WebSocket] Variable updated:', data);
            this.handleVariableUpdate(data);
        });

        this.socket.on('history_update', (data) => {
            logger.data('📝 [WebSocket] History updated:', data);
            this.updateHistory(data);
        });
    }

    handleVariableUpdate(data) {
        // Update the variable value in the UI
        const variableElement = document.querySelector(`[data-variable="${data.name}"]`);
        if (variableElement) {
            const valueElement = variableElement.querySelector('.variable-value');
            if (valueElement) {
                valueElement.textContent = data.value;
                valueElement.classList.add('updated');
                setTimeout(() => valueElement.classList.remove('updated'), 1000);
            }
        }
    }

    updateHistory(data) {
        const historyContainer = document.getElementById('modificationHistory');
        if (!historyContainer) {
            logger.error('❌ History container not found');
            return;
        }

        // Update the history of changes
        historyContainer.innerHTML = data.map(entry => `
            <div class="history-entry">
                <div class="history-time">${new Date(entry.timestamp).toLocaleString()}</div>
                <div class="history-details">
                    <div class="history-variable">${entry.variable}</div>
                    <div class="history-values">
                        <span class="history-old-value">${entry.old_value}</span>
                        <i class="fas fa-arrow-right"></i>
                        <span class="history-new-value">${entry.new_value}</span>
                    </div>
                </div>
            </div>
        `).join('');
    }
}
// SOCKET END

// CONTROLLER START
class UPSRWPage extends TimezonedPage {
    constructor() {
        super();
        this._timezone = this.getConfiguredTimezone();
        this.elements = {
            variablesList: document.getElementById('variablesList'),
            searchInput: document.getElementById('searchVariables'),
            refreshButton: document.getElementById('refreshVariables'),
            clearHistoryButton: document.getElementById('clearHistory'),
            modificationHistory: document.getElementById('modificationHistory'),
            editModal: document.getElementById('editModal'),
            clearConfirmModal: document.getElementById('clearConfirmModal'),
            infoModal: document.getElementById('infoModal'),
            editForm: document.getElementById('editForm'),
            variableNameSpan: document.getElementById('variableName'),
            currentValueSpan: document.getElementById('currentValue'),
            newValueInput: document.getElementById('newValue'),
            saveButton: document.getElementById('saveVariable'),
            confirmClearButton: document.getElementById('confirmClear'),
            infoModalBody: document.querySelector('#infoModal .modal-body'),
            infoTitle: document.getElementById('infoTitle'),
            infoDescription: document.getElementById('infoDescription'),
            infoWarning: document.getElementById('infoWarning')
        };
        
        // Add modal close handling
        document.querySelectorAll('.modal-close').forEach(button => {
            button.addEventListener('click', () => {
                this.hideAllModals();
            });
        });
        
        // Close modal by clicking outside
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.hideAllModals();
                }
            });
        });
        
        // Socket manager
        this.socketManager = new SocketManager();
        
        // Event listeners
        this.initializeEventListeners();
        
        // Load initial data
        this.loadVariables();
        
        // Load initial history
        this.loadHistory();
    }

    initializeEventListeners() {
        logger.page('Initialization of event listeners');
        
        // Save button
        this.elements.saveButton.addEventListener('click', () => {
            this.saveVariable();
        });
        
        // Clear history button
        this.elements.clearHistoryButton?.addEventListener('click', () => {
            this.clearHistory();
        });

        // Info button - updated to use the new class
        document.addEventListener('click', (e) => {
            const infoButton = e.target.closest('.info-button');
            if (infoButton) {
                const name = infoButton.getAttribute('data-variable');
                const variableData = infoButton.getAttribute('data-details');
                if (name && variableData) {
                    this.showInfoModal(name, variableData);
                }
            }
        });
    }

    async saveVariable() {
        const name = this.elements.variableNameSpan.textContent;
        const value = this.elements.newValueInput.value;
        
        logger.event('Saving variable:', { name, value });
        
        try {
            const response = await fetch('/api/upsrw/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, value })
            });
            
            const data = await response.json();
            
            if (data.success) {
                logger.event('Variable saved successfully');
                this.hideAllModals();
                await this.loadVariables();
                await this.loadHistory();
            } else {
                // Log of the full error
                logger.error('Server error:', data.error);
                throw new Error(data.error || 'Error during saving');
            }
        } catch (error) {
            logger.error('Variable saving error:', error.message);
            // Show the error to the user
            alert(`Error: ${error.message}`);
        }
    }

    async loadVariables() {
        logger.data('Loading variables...');
        try {
            const response = await fetch('/api/upsrw/list');
            const data = await response.json();
            
            if (data.success) {
                logger.data('Variables loaded:', data.variables.length);
                this.renderVariables(data.variables);
            } else {
                throw new Error(data.error);
            }
        } catch (error) {
            logger.error('Variables loading error:', error);
        }
    }

    renderVariables(variables) {
        logger.page('Rendering variables list:', variables.length);
        
        this.elements.variablesList.innerHTML = variables.map(variable => {
            const escapedVariable = JSON.stringify(variable).replace(/"/g, '&quot;');
            
            return `
                <div class="stat_card mini">
                    <div class="stat-icon">
                        <i class="fas fa-cog"></i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-header">
                            <span class="stat-label">${variable.name}</span>
                        </div>
                        <div class="stat-value">${variable.value}</div>
                        <div class="stat-actions">
                            <button class="btn-primary btn-small info-button" data-variable="${variable.name}" data-details='${escapedVariable}'>
                                <i class="fas fa-info-circle"></i>
                            </button>
                            <button class="btn-primary execute-button" 
                                    onclick="upsrwPage.showEditModal('${variable.name}', '${variable.value}')">
                                Modify
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    showModal(modal) {
        this.hideAllModals();
        modal.style.display = 'block';
        document.body.classList.add('modal-open');
    }

    hideAllModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.style.display = 'none';
        });
        document.body.classList.remove('modal-open');
    }

    showEditModal(name, value) {
        logger.event('Showing edit modal for:', name);
        this.elements.variableNameSpan.textContent = name;
        this.elements.currentValueSpan.textContent = value;
        this.elements.newValueInput.value = value;
        this.showModal(this.elements.editModal);
    }

    showInfoModal(name, variableStr) {
        logger.event('Showing info for:', name);
        const variable = typeof variableStr === 'string' ? JSON.parse(variableStr) : variableStr;
        
        this.elements.infoTitle.textContent = name;
        this.elements.infoDescription.textContent = variable.description;
        this.elements.infoWarning.innerHTML = `
            Type: ${variable.type}<br>
            Maximum length: ${variable.max_length}<br>
            Current value: ${variable.value}
        `;
        this.showModal(this.elements.infoModal);
    }

    async loadHistory() {
        try {
            const response = await fetch('/api/upsrw/history');
            const data = await response.json();
            
            if (data.success) {
                this.renderHistory(data.history);
            } else {
                throw new Error(data.error);
            }
        } catch (error) {
            logger.error('History loading error:', error);
        }
    }

    renderHistory(history) {
        if (!this.elements.modificationHistory) return;
        
        this.elements.modificationHistory.innerHTML = history.map(entry => `
            <div class="upscmd_log-entry">
                <div class="upscmd_log-time">${new Date(entry.timestamp).toLocaleString([], { timeZone: this._timezone })}</div>
                <div class="upscmd_log-content">
                    <div class="upscmd_log-command">
                        <strong>${entry.name}</strong>
                    </div>
                    <div class="upscmd_log-details">
                        ${entry.old_value} → ${entry.new_value}
                    </div>
                </div>
            </div>
        `).join('');
    }

    async clearHistory() {
        try {
            const response = await fetch('/api/upsrw/clear-history', {
                method: 'POST'
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.elements.modificationHistory.innerHTML = '';
            } else {
                throw new Error(data.error);
            }
        } catch (error) {
            logger.error('History clearing error:', error);
        }
    }
}

// Create a global instance to allow onclick calls from the template
window.upsrwPage = null;

// Initialize the page when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    logger.page('DOM loaded, page initialization');
    window.upsrwPage = new UPSRWPage();
}); 