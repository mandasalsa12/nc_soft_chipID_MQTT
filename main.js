const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const fs = require('fs');

try {
    require('@electron/remote/main').initialize();
} catch (e) {
    console.error('Error initializing @electron/remote:', e);
}

let mainWindow;
let displayWindow;
let serialPort = null;
let standbyNotificationShown = false;

// Fungsi untuk mendapatkan path sounds yang benar
function getSoundsPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'sounds');
    }
    return path.join(__dirname, 'sounds');
}

// Fungsi untuk memastikan direktori sounds ada
function ensureSoundsDirectory() {
    const soundsDir = getSoundsPath();
    if (!fs.existsSync(soundsDir)) {
        fs.mkdirSync(soundsDir, { recursive: true });
    }
    return soundsDir;
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    try {
        require('@electron/remote/main').enable(mainWindow.webContents);
    } catch (e) {
        console.error('Error enabling remote module:', e);
    }

    mainWindow.loadFile('index.html');
    
    // Uncomment untuk debugging
    // mainWindow.webContents.openDevTools();

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function createDisplayWindow() {
    displayWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    displayWindow.loadFile('display.html');
    displayWindow.on('closed', () => {
        displayWindow = null;
    });
}

function sendNotification(type, message) {
    if (mainWindow) {
        mainWindow.webContents.send('notification', { type, message });
    }
}

function saveConfig(data) {
    const configPath = path.join(__dirname, 'config.json');
    try {
        if (!data) {
            console.error('Invalid data to save:', data);
            return false;
        }

        if (!fs.existsSync(configPath)) {
            const initialData = {
                masterData: [],
                masterSettings: {},
                alertSettings: {
                    displayFormat: "K{room}B{bed}",
                    customFormat: "",
                    alertDuration: 30,
                    soundEnabled: false
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(initialData, null, 2));
        }

        const existingData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const newData = {
            ...existingData,
            ...data
        };

        fs.writeFileSync(configPath, JSON.stringify(newData, null, 2));
        console.log('Config saved successfully');
        return true;
    } catch (error) {
        console.error('Error saving config:', error);
        return false;
    }
}

function loadConfig() {
    const configPath = path.join(__dirname, 'config.json');
    try {
        if (!fs.existsSync(configPath)) {
            const initialData = {
                masterData: [],
                masterSettings: {},
                alertSettings: {
                    displayFormat: "K{room}B{bed}",
                    customFormat: "",
                    alertDuration: 30,
                    soundEnabled: false
                }
            };
            fs.writeFileSync(configPath, JSON.stringify(initialData, null, 2));
            return initialData;
        }
        const data = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading config:', error);
        return {
            masterData: [],
            masterSettings: {},
            alertSettings: {
                displayFormat: "K{room}B{bed}",
                customFormat: "",
                alertDuration: 30,
                soundEnabled: false
            }
        };
    }
}

app.whenReady().then(() => {
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.handle('open-display', () => {
    if (!displayWindow) {
        createDisplayWindow();
    } else {
        displayWindow.focus();
    }
});

ipcMain.handle('get-ports', async () => {
    try {
        const ports = await SerialPort.list();
        console.log('Available ports:', ports);
        return ports.map(port => ({
            path: port.path,
            manufacturer: port.manufacturer || 'Unknown',
            serialNumber: port.serialNumber || 'Unknown',
            vendorId: port.vendorId,
            productId: port.productId
        }));
    } catch (error) {
        console.error('Error getting ports:', error);
        return [];
    }
});

ipcMain.handle('connect-port', async (event, { port, baudRate }) => {
    try {
        console.log('Attempting to connect to port:', port, 'with baudRate:', baudRate);

        // Close existing connection if any
        if (serialPort && serialPort.isOpen) {
            console.log('Closing existing connection');
            await new Promise((resolve, reject) => {
                serialPort.close((err) => {
                    if (err) {
                        console.error('Error closing existing port:', err);
                        reject(err);
                        return;
                    }
                    console.log('Existing port closed successfully');
                    resolve();
                });
            });
        }

        // Create new serial port instance with error handling
        serialPort = new SerialPort({
            path: port,
            baudRate: parseInt(baudRate),
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            autoOpen: false
        });

        // Create parser for reading data
        const parser = new ReadlineParser({ delimiter: '\r\n' });
        serialPort.pipe(parser);

        // Set up event handlers
        serialPort.on('error', (err) => {
            console.error('Serial port error:', err);
            if (mainWindow) {
                mainWindow.webContents.send('serial-error', err.message);
            }
        });

        // Open the port with proper error handling
        return new Promise((resolve, reject) => {
            serialPort.open((err) => {
                if (err) {
                    console.error('Failed to open port:', err);
                    reject(err);
                    return;
                }

                console.log('Port opened successfully');
                
                if (mainWindow) {
                    mainWindow.webContents.send('serial-status', 'connected');
                }

                parser.on('data', (data) => {
                    try {
                        const cleanData = data.toString().trim();
                        console.log('Received data:', cleanData);
                        
                        if (mainWindow && cleanData) {
                            mainWindow.webContents.send('serial-data', cleanData);
                            mainWindow.webContents.send('serial-monitor-data', cleanData);
                        }
                    } catch (error) {
                        console.error('Error processing received data:', error);
                    }
                });

                resolve({ success: true, message: 'Connected successfully' });
            });
        });

    } catch (error) {
        console.error('Connection error:', error);
        throw error;
    }
});

ipcMain.handle('disconnect-port', async () => {
    try {
        if (serialPort && serialPort.isOpen) {
            return new Promise((resolve, reject) => {
                serialPort.close((err) => {
                    if (err) {
                        console.error('Error closing port:', err);
                        sendNotification('error', `Gagal menutup port: ${err.message}`);
                        reject(err);
                        return;
                    }
                    serialPort = null;
                    sendNotification('success', 'Berhasil memutuskan koneksi');
                    resolve(true);
                });
            });
        }
        return true;
    } catch (error) {
        console.error('Disconnection error:', error);
        sendNotification('error', `Gagal memutuskan koneksi: ${error.message}`);
        throw error;
    }
});

ipcMain.handle('load-config', async () => {
    return loadConfig();
});

ipcMain.handle('save-config', async (event, config) => {
    return saveConfig(config);
});

ipcMain.handle('select-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Sound Files', extensions: ['mp3', 'wav'] }
        ]
    });
    return result.filePaths;
});

ipcMain.handle('select-sound-files', async () => {
    try {
        const result = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Sound Files', extensions: ['wav'] }
            ]
        });

        if (!result.canceled && result.filePaths.length > 0) {
            const soundsDir = path.join(__dirname, 'sounds');
            
            // Buat direktori sounds jika belum ada
            if (!fs.existsSync(soundsDir)) {
                fs.mkdirSync(soundsDir);
            }

            // Salin setiap file yang dipilih ke folder sounds
            for (const filePath of result.filePaths) {
                const fileName = path.basename(filePath);
                const targetPath = path.join(soundsDir, fileName);
                
                // Salin file
                fs.copyFileSync(filePath, targetPath);
            }

            return result.filePaths.map(filePath => path.basename(filePath));
        }
        return [];
    } catch (error) {
        console.error('Error selecting sound files:', error);
        throw error;
    }
});

// Tambahkan fungsi untuk menangani notifikasi sistem
function showSystemNotification(title, body, urgency = 'normal') {
    if (Notification.isSupported()) {
        const notification = new Notification({
            title: title,
            body: body,
            silent: false,
            urgency: urgency, // 'normal', 'critical', or 'low'
            timeoutType: 'default'
        });
        
        notification.show();
        
        // Handle click event
        notification.on('click', () => {
            // Fokuskan window utama jika diklik
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }
        });
    }
}

// Tambahkan handler untuk notifikasi sistem
ipcMain.handle('show-system-notification', async (event, { title, body, urgency }) => {
    showSystemNotification(title, body, urgency);
});