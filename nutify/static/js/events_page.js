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

class EventsPage extends TimezonedPage {
    constructor() {
        super();
        this._timezone = this.getConfiguredTimezone();
        this.eventsData = [];
        this.notificationsEnabled = false;
        
        // Elements DOM
        this.eventsTableBody = document.getElementById('eventsTableBody');
        this.eventTypeFilter = document.getElementById('eventTypeFilter');
        this.timeFilter = document.getElementById('timeFilter');
        this.searchInput = document.getElementById('searchInput');
        this.selectAllCheckbox = document.getElementById('selectAll');
        
        // Statistics counters
        this.totalEventsCounter = document.getElementById('totalEvents');
        this.todayEventsCounter = document.getElementById('todayEvents');
        this.batteryTimeCounter = document.getElementById('batteryTime');
        this.lastEventCounter = document.getElementById('lastEvent');

        // Action buttons
        this.toggleNotificationsBtn = document.getElementById('toggleNotifications');
        this.clearEventsBtn = document.getElementById('clearEvents');
        this.acknowledgeSelectedBtn = document.getElementById('acknowledgeSelectedBtn');
        this.deleteSelectedBtn = document.getElementById('deleteSelectedBtn');

        // Bind methods
        this.toggleSelectAll = this.toggleSelectAll.bind(this);
        this.acknowledgeSelectedEvents = this.acknowledgeSelectedEvents.bind(this);
        this.deleteSelectedEvents = this.deleteSelectedEvents.bind(this);
        this.acknowledgeEvent = this.acknowledgeEvent.bind(this);
        this.deleteEvent = this.deleteEvent.bind(this);
        this.getSelectedEventIds = this.getSelectedEventIds.bind(this);
        this.requestNotificationPermission = this.requestNotificationPermission.bind(this);
        
        // Event listeners
        this.selectAllCheckbox?.addEventListener('change', (e) => {
            const checkboxes = this.eventsTableBody.querySelectorAll('.event-checkbox');
            checkboxes.forEach(checkbox => checkbox.checked = e.target.checked);
        });

        document.getElementById('acknowledgeSelectedBtn')?.addEventListener('click', () => this.acknowledgeSelectedEvents());
        document.getElementById('deleteSelectedBtn')?.addEventListener('click', () => this.deleteSelectedEvents());
        document.getElementById('updateTableBtn')?.addEventListener('click', () => this.updateEventsTable());
        
        // Add notifications event listener
        this.toggleNotificationsBtn?.addEventListener('click', () => this.requestNotificationPermission());

        // Check if notifications were previously granted
        if (Notification.permission === 'granted') {
            this.notificationsEnabled = true;
            this.updateNotificationButton();
        }

        // Load initial data
        this.updateEventsTable();
        
        // Update table every 30 seconds
        setInterval(() => this.updateEventsTable(), 30000);
    }

    toggleSelectAll(e) {
        const checkboxes = document.querySelectorAll('.event-checkbox');
        checkboxes.forEach(checkbox => {
            checkbox.checked = e.target.checked;
        });
    }

    async acknowledgeSelectedEvents() {
        const eventIds = this.getSelectedEventIds();
        if (eventIds.length === 0) {
            this.showNotification('Select at least one event', 'warning');
            return;
        }

        try {
            const response = await fetch('/api/events/acknowledge/bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event_ids: eventIds })
            });

            const data = await response.json();
            if (data.success) {
                this.updateEventsTable();
                this.showNotification('Events updated successfully', 'success');
            } else {
                this.showNotification(data.message || 'Error updating events', 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            this.showNotification('Error updating events', 'error');
        }
    }

    async deleteSelectedEvents() {
        const eventIds = this.getSelectedEventIds();
        if (eventIds.length === 0) {
            this.showNotification('Select at least one event', 'warning');
            return;
        }

        if (!confirm('Are you sure you want to delete the selected events?')) return;

        try {
            const response = await fetch('/api/events/delete/bulk', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event_ids: eventIds })
            });

            const data = await response.json();
            if (data.success) {
                this.updateEventsTable();
                this.showNotification('Events deleted successfully', 'success');
            } else {
                this.showNotification(data.message || 'Error deleting events', 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            this.showNotification('Error deleting events', 'error');
        }
    }

    async acknowledgeEvent(eventId) {
        try {
            const response = await fetch(`/api/events/acknowledge/${eventId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            const data = await response.json();
            if (data.success) {
                this.updateEventsTable();
                this.showNotification('Event updated successfully', 'success');
            } else {
                this.showNotification(data.message || 'Error updating event', 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            this.showNotification('Error updating event status', 'error');
        }
    }

    async deleteEvent(eventId) {
        if (!confirm('Are you sure you want to delete this event?')) return;

        try {
            const response = await fetch(`/api/events/delete/${eventId}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' }
            });

            const data = await response.json();
            if (data.success) {
                this.updateEventsTable();
                this.showNotification('Event deleted successfully', 'success');
            } else {
                this.showNotification(data.message || 'Error deleting event', 'error');
            }
        } catch (error) {
            console.error('Error:', error);
            this.showNotification('Error deleting event', 'error');
        }
    }

    getSelectedEventIds() {
        const checkboxes = this.eventsTableBody.querySelectorAll('.event-checkbox:checked');
        return Array.from(checkboxes).map(cb => parseInt(cb.value));
    }

    // Function to determine the event type
    getEventType(event) {
        const eventText = event.event.toLowerCase();
        if (eventText.includes('battery')) return 'battery';
        if (eventText.includes('line power')) return 'online';
        return 'error';
    }

    // Function to add an event to the list
    addEvent(event) {
        const eventsList = document.getElementById('events-list');
        const eventDiv = document.createElement('div');
        const eventType = this.getEventType(event);
        
        eventDiv.className = 'upscmd_log-entry';
        eventDiv.innerHTML = `
            <div class="upscmd_log-time">${this.formatDate(event.timestamp)}</div>
            <div class="upscmd_log-content">
                <div class="upscmd_log-command">
                    <strong>${event.ups}</strong>
                </div>
                <div class="upscmd_log-details">
                    ${event.event} (${event.source_ip})
                </div>
            </div>
        `;
        
        eventsList.insertBefore(eventDiv, eventsList.firstChild);
        this.updateStats();
        
        // Update also the historical events table
        this.updateEventsTable();
        
        // Desktop notification if enabled
        if (this.notificationsEnabled) {
            this.showNotification(event);
        }
    }

    // Function to update statistics
    updateStats() {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        const totalEvents = this.eventsData.length;
        const todayEvents = this.eventsData.filter(e => new Date(e.timestamp) >= today).length;
        
        // Calculate total battery time
        let batteryTime = 0;
        let lastBatteryStart = null;
        
        this.eventsData.forEach(event => {
            if (event.event.includes('on battery')) {
                lastBatteryStart = new Date(event.timestamp);
            } else if (event.event.includes('line power') && lastBatteryStart) {
                batteryTime += (new Date(event.timestamp) - lastBatteryStart) / 1000 / 60; // in minutes
                lastBatteryStart = null;
            }
        });
        
        document.getElementById('totalEvents').textContent = totalEvents;
        document.getElementById('todayEvents').textContent = todayEvents;
        document.getElementById('batteryTime').textContent = `${Math.round(batteryTime)}m`;
        document.getElementById('lastEvent').textContent = totalEvents > 0 ? 
            this.formatDate(this.eventsData[0].timestamp) : '-';
    }

    // Function to filter events
    filterEvents() {
        const searchText = document.getElementById('searchInput').value.toLowerCase();
        const eventType = document.getElementById('eventTypeFilter').value;
        const timeFilter = document.getElementById('timeFilter').value;
        
        const now = new Date();
        let timeLimit = new Date(0);
        
        switch(timeFilter) {
            case '1h':
                timeLimit = new Date(now - 3600000);
                break;
            case '24h':
                timeLimit = new Date(now - 86400000);
                break;
            case '7d':
                timeLimit = new Date(now - 604800000);
                break;
        }
        
        const filteredEvents = this.eventsData.filter(event => {
            const matchesSearch = event.ups.toLowerCase().includes(searchText) || 
                                event.event.toLowerCase().includes(searchText);
            const matchesType = eventType === 'all' || event.event.toLowerCase().includes(eventType);
            const matchesTime = new Date(event.timestamp) >= timeLimit;
            
            return matchesSearch && matchesType && matchesTime;
        });
        
        const eventsList = document.getElementById('events-list');
        eventsList.innerHTML = '';
        filteredEvents.forEach(this.addEvent.bind(this));
    }

    // Desktop notifications handling
    requestNotificationPermission() {
        // Check if notifications are supported
        if (!('Notification' in window)) {
            this.showNotification('Desktop notifications are not supported in this browser', 'warning');
            return;
        }

        // Check if we're in a secure context
        if (!window.isSecureContext) {
            this.showNotification('Notifications require a secure connection (HTTPS)', 'warning');
            return;
        }

        Notification.requestPermission().then(permission => {
            this.notificationsEnabled = permission === 'granted';
            this.updateNotificationButton();
            
            if (permission === 'granted') {
                this.showNotification('Notifications enabled successfully', 'success');
            } else if (permission === 'denied') {
                this.showNotification('Notifications blocked', 'error');
            }
        }).catch(error => {
            console.error('Error requesting notification permission:', error);
            this.showNotification('Error requesting notification permission', 'error');
        });
    }

    showNotification(event) {
        // Check if notifications are enabled and supported
        if (!('Notification' in window) || !window.isSecureContext || !this.notificationsEnabled) {
            return;
        }

        if (Notification.permission === 'granted') {
            new Notification('New UPS Event', {
                body: `${event.ups}: ${event.event}`,
                icon: '/static/favicon.ico',
                tag: 'ups-event',  // Prevents duplicate notifications
                renotify: true     // Allow new notifications even with same tag
            });
        }
    }

    updateNotificationButton() {
        const button = document.getElementById('toggleNotifications');
        button.innerHTML = `<i class="fas fa-bell"></i> Notifications ${this.notificationsEnabled ? 'On' : 'Off'}`;
        button.classList.toggle('btn-primary', this.notificationsEnabled);
        button.classList.toggle('btn-secondary', !this.notificationsEnabled);
    }

    // Wait for the DOM and socket to be ready
    async init() {
        // Event Listeners
        document.getElementById('searchInput').addEventListener('input', this.filterEvents.bind(this));
        document.getElementById('eventTypeFilter').addEventListener('change', this.filterEvents.bind(this));
        document.getElementById('timeFilter').addEventListener('change', this.filterEvents.bind(this));
        document.getElementById('clearEvents').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all events?')) {
                this.eventsData = [];
                document.getElementById('events-list').innerHTML = '';
                this.updateStats();
            }
        });
        document.getElementById('toggleNotifications').addEventListener('click', this.requestNotificationPermission.bind(this));

        // Load the event history
        try {
            const response = await fetch('/api/nut_history');
            const events = await response.json();
            webLogger.console('Loaded history:', events);
            this.eventsData = events;
            events.forEach(this.addEvent.bind(this));
            this.updateStats();
        } catch (error) {
            console.error('Error loading history:', error);
        }

        // Socket.IO connection handling
        const connectionType = document.getElementById('connectionType');
        const connectionStatus = document.getElementById('connectionStatus');

        // Configure the global socket
        if (typeof socket !== 'undefined') {
            socket.disconnect();
            socket.io.opts.transports = ['websocket'];
            socket.io.opts.upgrade = false;
            socket.io.opts.reconnection = true;
            socket.io.opts.reconnectionAttempts = 5;
            socket.io.opts.reconnectionDelay = 1000;
            socket.connect();

            // Socket event listeners
            socket.on('connect_error', (error) => {
                console.error('Connection Error:', error);
                connectionType.textContent = `Connection: ERROR (${error.message})`;
                connectionStatus.classList.add('disconnected');
                connectionStatus.classList.remove('connected');
            });

            socket.on('connect_timeout', (timeout) => {
                console.error('Connection Timeout:', timeout);
            });

            socket.on('connect', () => {
                webLogger.console('Socket.IO connected');
                webLogger.console('Transport type:', socket.io.engine.transport.name);
                
                connectionType.textContent = `Connection: ${socket.io.engine.transport.name.toUpperCase()}`;
                connectionStatus.classList.add('connected');
                connectionStatus.classList.remove('disconnected');
            });

            socket.on('disconnect', () => {
                webLogger.console('Socket.IO disconnected');
                connectionStatus.classList.add('disconnected');
                connectionStatus.classList.remove('connected');
            });

            // Monitor transport changes
            socket.io.engine.on('transportChange', (transport) => {
                webLogger.console('Transport changed to:', transport.name);
                connectionType.textContent = `Connection: ${transport.name.toUpperCase()}`;
            });

            socket.on('nut_update', function(data) {
                webLogger.console('Received NUT update:', data);
                this.eventsData.unshift(data);
                this.addEvent(data);
            }.bind(this));
        }

        // Update the table on startup
        this.updateEventsTable();
        
        // Update the table every 30 seconds
        setInterval(this.updateEventsTable.bind(this), 30000);
    }

    // Add the function for events from the database
    updateEventsTable() {
        fetch('/api/table/events?rows=50')
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                // Update the counters
                this.totalEventsCounter.textContent = data.rows.length;
                
                // Calculate today's events
                const today = new Date().setHours(0,0,0,0);
                const todayEvents = data.rows.filter(event => 
                    new Date(event.timestamp_tz_begin).setHours(0,0,0,0) === today
                );
                this.todayEventsCounter.textContent = todayEvents.length;

                // Find the last event
                if (data.rows.length > 0) {
                    const lastEvent = data.rows[0];
                    this.lastEventCounter.textContent = this.formatEventType(lastEvent.event_type);
                }

                // Calculate total battery time
                const batteryTime = this.calculateBatteryTime(data.rows);
                this.batteryTimeCounter.textContent = this.formatDuration(batteryTime);

                // Clean the table
                this.eventsTableBody.innerHTML = '';
                
                // Populate the table with new data
                data.rows.forEach(event => {
                    const row = document.createElement('tr');
                    
                    // Calculate the event duration
                    let duration = '';
                    if (event.event_type === 'ONBATT' && event.timestamp_tz_end) {
                        const start = new Date(event.timestamp_tz_begin);
                        const end = new Date(event.timestamp_tz_end);
                        const diff = Math.floor((end - start) / 1000);
                        const minutes = Math.floor(diff / 60);
                        const seconds = diff % 60;
                        duration = `${minutes}m ${seconds}s`;
                    } else if (event.event_type === 'ONBATT') {
                        duration = 'In progress...';
                    }

                    row.innerHTML = `
                        <td><input type="checkbox" class="event-checkbox" value="${event.id}"></td>
                        <td>${this.formatDateTime(event.timestamp_tz_begin)}</td>
                        <td>
                            <span class="event_badge ${event.event_type.toLowerCase()}">
                                ${this.formatEventType(event.event_type)}
                            </span>
                        </td>
                        <td>
                            <span class="status-badge ${event.acknowledged ? 'seen' : 'new'}">
                                ${event.acknowledged ? 'Seen' : 'New'}
                            </span>
                        </td>
                        <td>${duration}</td>
                        <td>
                            <div class="event_actions">
                                ${!event.acknowledged ? `
                                    <button class="event_action_btn" onclick="eventsPage.acknowledgeEvent(${event.id})">
                                        <i class="fas fa-check"></i>
                                    </button>
                                ` : ''}
                                <button class="event_action_btn" onclick="eventsPage.deleteEvent(${event.id})">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    `;
                    
                    this.eventsTableBody.appendChild(row);
                });
            })
            .catch(error => {
                console.error('Error updating events table:', error);
                this.showNotification('Error loading events', 'error');
            });
    }

    formatEventType(eventType) {
        const eventTypes = {
            'ONBATT': 'On Battery',
            'ONLINE': 'Online',
            'LOWBATT': 'Low Battery',
            'COMMOK': 'Comm OK',
            'COMMBAD': 'Comm Bad',
            'SHUTDOWN': 'Shutdown',
            'REPLBATT': 'Replace Battery',
            'NOCOMM': 'No Communication',
            'NOPARENT': 'No Parent'
        };
        return eventTypes[eventType] || eventType;
    }

    formatDateTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleString([], {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: this._timezone
        });
    }

    calculateBatteryTime(events) {
        let totalTime = 0;
        events.forEach(event => {
            if (event.event_type === 'ONBATT' && event.timestamp_tz_end) {
                const start = new Date(event.timestamp_tz_begin);
                const end = new Date(event.timestamp_tz_end);
                totalTime += (end - start) / 1000; // convert to seconds
            }
        });
        return totalTime;
    }

    formatDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}m ${remainingSeconds}s`;
    }

    formatDate(timestamp) {
        return new Date(timestamp).toLocaleString(window.APP_CONFIG && window.APP_CONFIG.locale ? window.APP_CONFIG.locale : undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    // Function to show notifications
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <i class="fas ${this.getNotificationIcon(type)}"></i>
            <span>${message}</span>
        `;
        
        document.body.appendChild(notification);
        
        // Remove the notification after 3 seconds
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }

    getNotificationIcon(type) {
        const icons = {
            'success': 'fa-check-circle',
            'error': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        };
        return icons[type] || icons.info;
    }
}

// Initialize the page
document.addEventListener('DOMContentLoaded', () => {
    window.eventsPage = new EventsPage();
}); 