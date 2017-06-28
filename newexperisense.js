// picoExtension.js
// Shane M. Clements, February 2014
// PicoBoard Scratch Extension
//
// This is an extension for development and testing of the Scratch Javascript Extension API.

(function(ext) {
    var device = null;
    var rawData = null;

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
            return channels.EXT1.value;
        } else {
            return channels[which];
        }
    }
    
    function getLightSensor() {
        var v = channels.EXT2.value;
        return (v < 25) ? 100 - v : Math.round((1023 - v) * (75 / 998));
    }

    function processData() {
        var bytes = new Uint8Array(rawData);

        inputArray[7] = 0;

        // TODO: make this robust against misaligned packets.
        // Right now there's no guarantee that our 18 bytes start at the beginning of a message.
        // Maybe we should treat the data as a stream of 2-byte packets instead of 18-byte packets.
        // That way we could just check the high bit of each byte to verify that we're aligned.
        for (var i = 0; i < 8; ++i) {
            var hb = bytes[i * 2] & 0x7F;
            var channel = (hb >> 3) & 0x07;
            var lb = bytes[(i * 2) + 1] & 0x7F;
            channels[channel].sensitivity = !!(hb >> 6);
            channels[channel].value = ((hb & 0x07) << 7) + lb;
        }

        if (watchdog && (inputArray[15] === 0x01)) {
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

        device.open({stopBits: 0, bitRate: 38400, ctsFlowControl: 0});
        device.set_receive_handler(function (data) {
            //console.log('Received: ' + data.byteLength);
            if (!rawData || rawData.byteLength === 18) {
                rawData = new Uint8Array(data);
            }
            else rawData = appendBuffer(rawData, data);

            if (rawData.byteLength >= 18) {
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
            ['r', '%m.sensor sensor value', 'sensor', 'slider'],
            ['r', 'read from %m.port', 'sensor', 'A']
        ],
        menus: {
            booleanSensor: ['button pressed', 'A connected', 'B connected', 'C connected', 'D connected'],
            sensor: ['dial', 'light'],
            port: ['A', 'B', 'C', 'D', 'EXT1', 'EXT2'],
            lessMore: ['>', '<']
        },
        //TODO: update URL
        url: '/info/help/studio/tips/ext/PicoBoard/'
    };
    ScratchExtensions.register('ExperiSense', descriptor, ext, {type: 'serial'});
})({});
