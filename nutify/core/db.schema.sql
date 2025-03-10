/*
File: db.schema.sql
Description: SQLite database schema for UPS monitoring
Technology: SQLite3
Scope: 
- Defines the structure of the database tables
- Stores static and dynamic UPS data
- Tracks the history of measurements
- Optimizes queries with appropriate indices

Structure:
- Table ups_static_data: Data that rarely changes
- Table ups_dynamic_data: Data that changes continuously
- Indices to optimize common queries

Note:
- The static table has only one record (id = 1)
- The dynamic table grows over time with measurements
- All fields are nullable for maximum compatibility
*/

-- Table for UPS static data
-- Contains information that rarely changes
CREATE TABLE IF NOT EXISTS ups_static_data (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- Forces a single record
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,  -- This is ok to leave because it's only for tracking
    
    -- Device information (static)
    device_model TEXT,      -- Device model
    device_mfr TEXT,        -- Device manufacturer
    device_serial TEXT,     -- Device serial number
    device_type TEXT,       -- Device type
    device_description TEXT,-- Device description
    device_contact TEXT,    -- Device contact
    device_location TEXT,   -- Device location
    device_part TEXT,       -- Device part number
    device_macaddr TEXT,    -- Device MAC address
    device_usb_version TEXT,-- Device USB version
    
    -- UPS information (static)
    ups_model TEXT,         -- UPS model
    ups_mfr TEXT,          -- UPS manufacturer
    ups_mfr_date TEXT,     -- UPS production date
    ups_serial TEXT,       -- UPS serial number
    ups_vendorid TEXT,     -- UPS vendor ID
    ups_productid TEXT,    -- UPS product ID
    ups_firmware TEXT,     -- Firmware version
    ups_firmware_aux TEXT, -- Auxiliary firmware version
    ups_type TEXT,        -- UPS type
    ups_id TEXT,          -- UPS ID
    ups_display_language TEXT, -- Display language
    ups_contacts TEXT,    -- Contacts
    
    -- Battery information (static)
    battery_type TEXT,    -- Battery type
    battery_date TEXT,    -- Battery date
    battery_mfr_date TEXT,-- Battery production date
    battery_packs INTEGER,-- Number of battery packs
    battery_packs_external INTEGER, -- External battery packs
    battery_protection TEXT, -- Battery protection
    
    -- Driver information
    driver_name TEXT,     -- Driver name
    driver_version TEXT,  -- Driver version
    driver_version_internal TEXT, -- Internal driver version
    driver_version_data TEXT,    -- Data driver version
    driver_version_usb TEXT      -- USB driver version
);

-- Table for UPS dynamic data
-- Contains measurements that change over time
CREATE TABLE IF NOT EXISTS ups_dynamic_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_tz DATETIME NOT NULL,  -- Only timestamp_tz

    -- Device information
    device_uptime INTEGER,
    device_count INTEGER,

    -- UPS information
    ups_status TEXT,
    ups_alarm TEXT,
    ups_time TEXT,
    ups_date TEXT,
    ups_temperature REAL,
    ups_load REAL,
    ups_load_high REAL,
    ups_delay_start INTEGER,
    ups_delay_reboot INTEGER,
    ups_delay_shutdown INTEGER,
    ups_timer_start INTEGER,
    ups_timer_reboot INTEGER,
    ups_timer_shutdown INTEGER,
    ups_test_interval INTEGER,
    ups_test_result TEXT,
    ups_test_date TEXT,
    ups_display_language TEXT,
    ups_efficiency REAL,
    ups_power REAL,
    ups_power_nominal REAL,
    ups_realpower REAL,
    ups_realpower_hrs REAL,
    ups_realpower_nominal REAL,
    ups_beeper_status TEXT,
    ups_watchdog_status TEXT,
    ups_start_auto TEXT,
    ups_start_battery TEXT,
    ups_start_reboot TEXT,
    ups_shutdown TEXT,

    -- Input measurements
    input_voltage REAL,
    input_voltage_maximum REAL,
    input_voltage_minimum REAL,
    input_voltage_status TEXT,
    input_voltage_nominal REAL,
    input_voltage_extended REAL,
    input_transfer_low REAL,
    input_transfer_high REAL,
    input_sensitivity TEXT,
    input_frequency REAL,
    input_frequency_nominal REAL,
    input_current REAL,
    input_current_nominal REAL,
    input_realpower REAL,
    input_realpower_nominal REAL,

    -- Output measurements
    output_voltage REAL,
    output_voltage_nominal REAL,
    output_frequency REAL,
    output_frequency_nominal REAL,
    output_current REAL,
    output_current_nominal REAL,

    -- Battery measurements
    battery_charge REAL,
    battery_charge_low REAL,
    battery_charge_warning REAL,
    battery_voltage REAL,
    battery_voltage_nominal REAL,
    battery_current REAL,
    battery_temperature REAL,
    battery_runtime INTEGER,
    battery_runtime_low INTEGER,
    battery_alarm_threshold REAL,

    -- Ambient measurements (if sensors present)
    ambient_temperature REAL,
    ambient_humidity REAL,
    ambient_temperature_high REAL,
    ambient_temperature_low REAL,
    ambient_humidity_high REAL,
    ambient_humidity_low REAL,

    -- Real power days
    ups_realpower_days DECIMAL(10,2)
);

-- Indices to optimize common queries
DROP INDEX IF EXISTS idx_timestamp;
CREATE INDEX IF NOT EXISTS idx_timestamp_tz ON ups_dynamic_data(timestamp_tz);
CREATE INDEX IF NOT EXISTS idx_ups_status ON ups_dynamic_data(ups_status);  -- For status queries
CREATE INDEX IF NOT EXISTS idx_battery_charge ON ups_dynamic_data(battery_charge);  -- For battery queries
CREATE INDEX IF NOT EXISTS idx_ups_realpower_hrs ON ups_dynamic_data(ups_realpower_hrs);
CREATE INDEX IF NOT EXISTS idx_ups_realpower_days ON ups_dynamic_data(ups_realpower_days);
CREATE INDEX IF NOT EXISTS idx_timestamp_hour ON ups_dynamic_data(
    substr(timestamp_tz, 1, 13) || ':00:00'
);

-- Table for UPS events
CREATE TABLE IF NOT EXISTS ups_events_socket (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_tz DATETIME NOT NULL,  
    timestamp_tz_begin DATETIME,     
    timestamp_tz_end DATETIME,       
    ups_name VARCHAR(255),
    event_type VARCHAR(50),
    event_message TEXT,
    source_ip VARCHAR(45),
    acknowledged BOOLEAN DEFAULT 0
);

-- Update indices for ups_events
DROP INDEX IF EXISTS idx_events_timestamp;
CREATE INDEX IF NOT EXISTS idx_events_timestamp_tz ON ups_events_socket(timestamp_tz);

-- Table for email configuration
CREATE TABLE IF NOT EXISTS ups_opt_mail_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    smtp_server TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    username TEXT,
    password BLOB,
    enabled BOOLEAN DEFAULT 0,
    last_test_date DATETIME,
    last_test_status TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Add after other tables

CREATE TABLE IF NOT EXISTS ups_opt_notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type VARCHAR(50) NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index to optimize event_type queries
CREATE INDEX IF NOT EXISTS idx_notification_event_type ON ups_opt_notification(event_type);

-- Insert default event types
INSERT OR IGNORE INTO ups_opt_notification (event_type) VALUES 
('ONBATT'),
('ONLINE'),
('LOWBATT'),
('COMMOK'),
('COMMBAD'),
('SHUTDOWN'),
('REPLBATT'),
('NOCOMM'),
('NOPARENT');

CREATE TABLE IF NOT EXISTS ups_opt_variable_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
    price_per_kwh DECIMAL(10,4) NOT NULL DEFAULT 0.25,
    co2_factor DECIMAL(10,4) NOT NULL DEFAULT 0.4,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Insert default values if table is empty
INSERT OR IGNORE INTO ups_opt_variable_config (id, currency, price_per_kwh, co2_factor) 
VALUES (1, 'EUR', 0.25, 0.4);

CREATE TABLE IF NOT EXISTS ups_variables_upscmd (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command VARCHAR(100) NOT NULL,
    timestamp_tz DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    output TEXT
);
