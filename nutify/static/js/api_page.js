let apiPage;

// Check if TimezonedPage is already defined; if not, define it.
if (typeof window.TimezonedPage === 'undefined') {
    class TimezonedPage {
        getConfiguredTimezone() {
            const metaTag = document.querySelector('meta[name="timezone"]');
            if (metaTag && metaTag.content) {
                return metaTag.content;
            }
            if (window.APP_CONFIG && window.APP_CONFIG.timezone) {
                return window.APP_CONFIG.timezone;
            }
            webLogger.error('Timezone configuration not found');
            throw new Error('Timezone configuration is required');
        }
    }
    window.TimezonedPage = TimezonedPage;
}

class ApiPage extends TimezonedPage {
    constructor() {
        super();
        this._timezone = this.getConfiguredTimezone();
        apiPage = this;  // Save the instance for global access
        this.staticData = null;
        this.dynamicData = null;
        this.openCard = null;
        
        // First define the function
        this.tryLoadUpsModel = function() {
            fetch('/api/data/device_model')
                .then(response => response.json())
                .then(data => {
                    if (data.success && data.data.device_model) {
                        document.getElementById('ups-model').textContent = `UPS Model: ${data.data.device_model}`;
                    } else {
                        setTimeout(this.tryLoadUpsModel, 1000);
                    }
                })
                .catch(error => {
                    setTimeout(this.tryLoadUpsModel, 1000);
                });
        }
        
        // Then call init and tryLoadUpsModel
        this.init();
        this.tryLoadUpsModel();

        this.downloadFullApiJson = function() {
            Promise.all([
                fetch('/api/data/all').then(r => r.json()),
                fetch('/api/database-info').then(r => r.json())
            ])
            .then(([allData, dbInfo]) => {
                const fullJson = {
                    timestamp: new Date().toLocaleString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, { timeZone: this._timezone }),
                    ups_model: document.getElementById('ups-model').textContent,
                    database_info: dbInfo,
                    current_data: allData
                };

                const blob = new Blob([JSON.stringify(fullJson, null, 2)], { type: 'application/json' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `ups_api_data_${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
            })
            .catch(error => {
                console.error('Error downloading API data:', error);
                alert('Error downloading API data. Check console for details.');
            });
        }

        this.updateTable = function(tableId, data) {
            const table = document.getElementById(tableId);
            if (!table) return;
            const thead = table.querySelector('thead tr');
            const tbody = table.querySelector('tbody');
            if (!data || !data.success) return;
            thead.innerHTML = '';
            tbody.innerHTML = '';
            data.columns.forEach(column => {
                thead.innerHTML += `
                    <th class="api_px-4 api_py-2 api_text-left api_text-xs api_font-medium api_text-gray-500 api_uppercase api_tracking-wider">
                        ${column}
                    </th>
                `;
            });
            data.rows.forEach(row => {
                const tr = document.createElement('tr');
                tr.className = 'api_hover:bg-gray-50';
                data.columns.forEach(column => {
                    const value = row[column] !== null ? row[column] : '';
                    tr.innerHTML += `
                        <td class="api_px-4 api_py-2 api_text-sm api_text-gray-900 api_border-t">
                            ${value}
                        </td>
                    `;
                });
                tbody.appendChild(tr);
            });
        }
    }

    async init() {
        try {
            // Load static data
            const staticResponse = await fetch('/api/table/static?rows=1');
            this.staticData = await staticResponse.json();
            this.renderDataList('staticDataList', this.staticData, 'database');

            // Load dynamic data
            const dynamicResponse = await fetch('/api/table/dynamic?rows=1');
            this.dynamicData = await dynamicResponse.json();
            this.renderDataList('dynamicDataList', this.dynamicData, 'chart-line');

        } catch (error) {
            console.error('Error loading data:', error);
        }
    }

    renderDataList(containerId, data, iconType) {
        const container = document.getElementById(containerId);
        const template = document.getElementById('commandTemplate');
        
        if (!container || !template || !data?.columns) return;
        
        container.innerHTML = ''; // Clear container
        
        data.columns.forEach(column => {
            const clone = template.content.cloneNode(true);
            
            // Update the template content
            const wrapper = clone.querySelector('.api_command-wrapper');
            const nameSpan = clone.querySelector('.column-name');
            const description = clone.querySelector('.api_command-description');
            const icon = clone.querySelector('.fas');
            
            nameSpan.textContent = column.replace('_', ' ').toUpperCase();
            description.textContent = `/api/data/${column}`;
            icon.className = `fas fa-${iconType}`;
            
            // Add event listener
            wrapper.addEventListener('click', () => this.toggleCard(column, wrapper));
            
            container.appendChild(clone);
        });
    }

    async toggleCard(column, wrapper) {
        const details = wrapper.querySelector('.api_log-details');
        const pre = wrapper.querySelector('.api-data');
        
        if (this.openCard === column) {
            details.classList.add('hidden');
            this.openCard = null;
        } else {
            // Close the previous card if it exists
            if (this.openCard) {
                const prevCard = document.querySelector(`[data-column="${this.openCard}"] .api_log-details`);
                if (prevCard) prevCard.classList.add('hidden');
            }
            
            details.classList.remove('hidden');
            this.openCard = column;
            
            // Load data if not already loaded
            try {
                const response = await fetch(`/api/data/${column}`);
                const data = await response.json();
                pre.textContent = JSON.stringify(data, null, 2);
            } catch (error) {
                pre.textContent = 'Error loading data';
                console.error(error);
            }
        }
    }
}

window.downloadFullApiJson = function() {
    apiPage.downloadFullApiJson();
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new ApiPage();
}); 