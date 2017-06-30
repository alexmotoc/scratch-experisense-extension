// picoExtension.js
// Shane M. Clements, February 2014
// PicoBoard Scratch Extension
//
// This is an extension for development and testing of the Scratch Javascript Extension API.

(function (ext) {
    var device = null;
    var rawData = null;
    
    //Number of byte pairs transmitted per query response
    var messageLength = 8;

    // Sensor states:
    var channels = {
        EXT2: {channel: 0, value: null, sensitivity: false},
        EXT1: {channel: 1, value: null, sensitivity: false},
        D: {channel: 2, value: null, sensitivity: false},
        C: {channel: 3, value: null, sensitivity: false},
        B: {channel: 4, value: null, sensitivity: false},
        A: {channel: 5, value: null, sensitivity: false},
        button: {channel: 6, value: null}
    };
    
    //TODO: generate programatically
    var channelLookup = ['EXT2', 'EXT1', 'D', 'C', 'B', 'A', 'button', 'id'];

    ext.resetAll = function (){};

    // Hats / triggers
    ext.whenSensorConnected = function (which) {
        return getSensorPressed(which);
    };

    ext.whenSensorPass = function (which, sign, level) {
        if (sign === '<') return getSensor(which) < level;
        return getSensor(which) > level;
    };

    // Reporters
    ext.sensorPressed = function (which) {
        return getSensorPressed(which);
    };

    ext.sensor = function (which) {
        return getSensor(which);
    };
    
    ext.read = function (sensitivity, which, callback) {
        readScaled(sensitivity === 'sensitive', which, callback);
    }
    
    ext.readResistance = function (sensitivity, which, callback) {
        readResistance(sensitivity === 'sensitive', which, callback);
    }
    
    ext.firstSegmentDisplay = function (num) {
        writeDisplay(num, 1);
    }
    
    ext.secondSegmentDisplay = function (num) {
        writeDisplay(num, 2);   
    }
    
    ext.twoDigitSegmentDisplay = function (num) {
        writeDisplay(num, 3);   
    }
    
    ext.clearDisplays = clearDisplays;

    // Private logic
    function getSensorPressed(which) {
        if (device === null) return false;
        if (which === 'button pressed' && getSensor('button') < 1) return true;
        if (which === 'A connected' && getSensor('A') < 10) return true;
        if (which === 'B connected' && getSensor('B') < 10) return true;
        if (which === 'C connected' && getSensor('C') < 10) return true;
        if (which === 'D connected' && getSensor('D') < 10) return true;
        return false;
    }

    function getSensor(which) {
        if (which === 'light') {
            return getLightSensor();
        } else if (which === 'dial') {
            return scaleSensor(channels.EXT1.value);
        } else {
            return scaleSensor(channels[which].value);
        }
    }

    function readPoll(sensitivity, which, callback) {
        // If already in the right sensitivity mode we're good to go!
        if (channels[which].sensitivity === sensitivity) {
            callback(); 
        } else {
            // Switch sensitivity mode and wait to test.
            // Keep spamming in case of packet loss
            switchSensitivity(which, sensitivity);
            setTimeout(function () {
                readPoll(sensitivity, which, callback);
            }, 100);
        }
    }
    
    function readScaled(sensitivity, which, callback) {
        function report() {
            callback(scaleSensor(channels[which].value));
        }
        
        readPoll(sensitivity, which, report);
    }
    
    function readResistance(sensitivity, which, callback) {
        function report() {
            // Value of resistors in resistive divider
            var resistance = (sensitivity === 'normal') ? 10 : 1000 + 10,
                vIn = 5,
                vOut = channels[which].value / 1023 * 5;
            
            callback(resistance / (vIn / vOut - 1));
        }
        
        readPoll(sensitivity, which, report);
    }
    
    function switchSensitivity(which, sensitivity) { 
        var sensitivityCmd = new Uint8Array([(1 << 7) | ((sensitivity ? 1 : 0) << 3) | channels[which].channel]);
        console.log(sensitivityCmd[1]);
        device.send(sensitivityCmd.buffer);
    }
    
    function scaleSensor(value) {
        return (100 * value) / 1023; 
    }
    
    function getLightSensor() {
        var v = channels.EXT2.value;
        return (v < 25) ? 100 - v : Math.round((1023 - v) * (75 / 998));
    }
    
    function writeDisplay(num, display) {
        // display 1 == 1st, display 2 == 2nd, display 3 == both
        // following byte == number to display
        var displayCmd = new Uint8Array([display | 0x40, num]);
        device.send(displayCmd.buffer);
    }
    
    function clearDisplays() {
        // display 4 == clear (no following byte)
        var clearCmd = new Uint8Array([0x40 | 4]);
        device.send(clearCmd.buffer);
    }

    function processData() {
        var bytes = new Uint8Array(rawData);

        var firmwareId = null;

        // TODO: make this robust against misaligned packets.
        // Right now there's no guarantee that our 18 bytes start at the beginning of a message.
        // Maybe we should treat the data as a stream of 2-byte packets instead of 18-byte packets.
        // That way we could just check the high bit of each byte to verify that we're aligned.
        for (var i = 0; i < messageLength; ++i) {
            var hb = bytes[i * 2] & 0x7F;
            var channel = (hb >> 3) & 0x07;
            var lb = bytes[(i * 2) + 1] & 0x7F;
            var value = ((hb & 0x07) << 7) + lb;
            if (channelLookup[channel] === 'id') {
                // Deal with magic id channel that doesn't correspond to an actual input
                firmwareId = value;
                continue;
            }
            channels[channelLookup[channel]].sensitivity = !!(hb >> 6);
            channels[channelLookup[channel]].value = value;
        }

        if (watchdog && firmwareId === 0x01) {
            // Seems to be a valid PicoBoard.
            clearTimeout(watchdog);
            watchdog = null;
        }

        //console.log(inputs);
        rawData = null;
    }

    function appendBuffer(buffer1, buffer2) {
        var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
        tmp.set(new Uint8Array(buffer1), 0);
        tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
        return tmp.buffer;
    }

    // Extension API interactions
    var potentialDevices = [];
    ext._deviceConnected = function (dev) {
        potentialDevices.push(dev);

        if (!device) {
            tryNextDevice();
        }
    }

    var poller = null;
    var watchdog = null;
    function tryNextDevice() {
        // If potentialDevices is empty, device will be undefined.
        // That will get us back here next time a device is connected.
        device = potentialDevices.shift();
        if (!device) {
            return;
        }

        device.open({stopBits: 0, bitRate: 115200, ctsFlowControl: 0});
        device.set_receive_handler(function (data) {
            //console.log('Received: ' + data.byteLength);
            if (!rawData || rawData.byteLength === messageLength * 2) {
                rawData = new Uint8Array(data);
            }
            else rawData = appendBuffer(rawData, data);

            if (rawData.byteLength >= messageLength * 2) {
                //console.log(rawData);
                processData();
                //device.send(pingCmd.buffer);
            }
        });

        // Tell the PicoBoard to send a input data every 50ms
        var pingCmd = new Uint8Array(1);
        pingCmd[0] = 0x02;
        poller = setInterval(function () {
            device.send(pingCmd.buffer);
        }, 50);
        watchdog = setTimeout(function () {
            // This device didn't get good data in time, so give up on it. Clean up and then move on.
            // If we get good data then we'll terminate this watchdog.
            clearInterval(poller);
            poller = null;
            device.set_receive_handler(null);
            device.close();
            device = null;
            tryNextDevice();
        }, 250);
    };

    ext._deviceRemoved = function (dev) {
        if (device != dev) {
            return;
        }
        if (poller) {
            poller = clearInterval(poller);
        }
        device = null;
    };

    ext._shutdown = function () {
        if (device) {
            device.close();
        }
        if (poller) {
            poller = clearInterval(poller);
        }
        device = null;
    };

    ext._getStatus = function () {
        if (!device) {
            return {status: 1, msg: 'ExperiSense disconnected'};
        }
        if (watchdog) {
            return {status: 1, msg: 'Probing for ExperiSense'};
        }
        return {status: 2, msg: 'ExperiSense connected'};
    }

    var descriptor = {
        blocks: [
            ['h', 'when %m.booleanSensor', 'whenSensorConnected', 'button pressed'],
            ['h', 'when %m.sensor %m.lessMore %n', 'whenSensorPass', 'slider', '>', 50],
            ['b', 'sensor %m.booleanSensor?', 'sensorPressed', 'button pressed'],
            ['r', '%m.sensor sensor value', 'sensor', 'dial'],
            ['r', '%m.ext value', 'sensor', 'EXT1'],
            ['R', '%m.sensitivity read from %m.resistance', 'read', 'normal', 'A'],
            ['R', '%m.sensitivity read resistance from %m.resistance (kΩ)', 'readResistance', 'normal', 'A'],
            ['-'],
            [' ' , 'show %n on first display', 'firstSegmentDisplay', 1],
            [' ', 'show %n on second display', 'secondSegmentDisplay', 1],
            [' ', 'display two-digit number %n', 'twoDigitSegmentDisplay', 10],
            [' ', 'clear displays', 'clearDisplays']
        ],
        menus: {
            booleanSensor: ['button pressed', 'A connected', 'B connected', 'C connected', 'D connected'],
            sensor: ['dial', 'light'],
            resistance: ['A', 'B', 'C', 'D'],
            ext: ['EXT1', 'EXT2'],
            get port() { return this.resistance.concat(this.ext); },
            lessMore: ['>', '<'],
            sensitivity: ['normal', 'sensitive']
        },
        //TODO: update URL
        url: '/info/help/studio/tips/ext/PicoBoard/'
    };
    ScratchExtensions.register('ExperiSense', descriptor, ext, {type: 'serial'});
})({});
