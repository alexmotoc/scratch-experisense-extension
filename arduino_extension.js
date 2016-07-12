/*
 *This program is free software: you can redistribute it and/or modify
 *it under the terms of the GNU General Public License as published by
 *the Free Software Foundation, either version 3 of the License, or
 *(at your option) any later version.
 *
 *This program is distributed in the hope that it will be useful,
 *but WITHOUT ANY WARRANTY; without even the implied warranty of
 *MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *GNU General Public License for more details.
 *
 *You should have received a copy of the GNU General Public License
 *along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

(function(ext) {

  var PIN_MODE = 0xF4,
    REPORT_DIGITAL = 0xD0,
    REPORT_ANALOG = 0xC0,
    DIGITAL_MESSAGE = 0x90,
    START_SYSEX = 0xF0,
    END_SYSEX = 0xF7,
    QUERY_FIRMWARE = 0x79,
    REPORT_VERSION = 0xF9,
    ANALOG_MESSAGE = 0xE0,
    ANALOG_MAPPING_QUERY = 0x69,
    ANALOG_MAPPING_RESPONSE = 0x6A,
    CAPABILITY_QUERY = 0x6B,
    CAPABILITY_RESPONSE = 0x6C,
    PIN_STATE_QUERY = 0x6D,
    PIN_STATE_RESPONSE = 0x6E;

  var INPUT = 0x00,
    OUTPUT = 0x01,
    ANALOG = 0x02,
    PWM = 0x03,
    SERVO = 0x04,
    SHIFT = 0x05,
    I2C = 0x06,
    ONEWIRE = 0x07,
    STEPPER = 0x08,
    ENCODER = 0x09,
    SERIAL = 0x0A,
    PULLUP = 0x0B,
    IGNORE = 0x7F,
    TOTAL_PIN_MODES = 13;

  var LOW = 0,
    HIGH = 1;

  var MAX_DATA_BYTES = 4096;
  var MAX_PINS = 128;

  var parsingSysex = false,
    waitForData = 0,
    executeMultiByteCommand = 0,
    multiByteChannel = 0,
    sysexBytesRead = 0,
    storedInputData = new Uint8Array(MAX_DATA_BYTES);

  var digitalOutputData = new Uint8Array(16),
    digitalInputData = new Uint8Array(16),
    analogInputData = new Uint16Array(16);

  var analogChannel = new Uint8Array(MAX_PINS);
  var pinModes = [];
  for (var i = 0; i < TOTAL_PIN_MODES; i++) pinModes[i] = [];

  var majorVersion = 0,
    minorVersion = 0;

  var connected = false;
  var notifyConnection = false;
  var device = null;
  var inputData = null;
  
  var analogReadCallbacks = [];
  
  var analogConnectionMapping = {
    A: 2,
    B: 3,
    C: 4,
    D: 5,
    EXT1: 0,
    EXT2: 1
  };
  
  var digitalConnectionMapping = {};
  
  for (conn in analogConnectionMapping) {
    if (analogConnectionMapping.hasOwnProperty(conn)) {
      digitalConnectionMapping[conn] = analogConnectionMapping[conn] + 14;
    }
  }

  // TEMPORARY WORKAROUND
  // Since _deviceRemoved is not used with Serial devices
  // ping device regularly to check connection
  var pinging = false;
  var pingCount = 0;
  var pinger = null;

  var hwList =  {
    devices: [
      {name: 'built-in button', pin: 6, val: 0},
      {name: 'light sensor', pin: 1, val: 0},
      {name: 'dial', pin: 0, val: 0}
    ],
    add: function (dev, pin) {
      var device = this.search(dev);
      if (!device) {
        device = {name: dev, pin: pin, val: 0};
        this.devices.push(device);
      } else {
        device.pin = pin;
        device.val = 0;
      }
    },
    search: function (dev) {
      var i;
      for (i=0; i<this.devices.length; i++) {
        if (this.devices[i].name === dev) {
          return this.devices[i];
        }
      }
      return null;
    }
  }
  
  var pinStates = {
    lowCallbacks: [],
    highCallbacks: [],
    processCallbacks: function (pin, state) {
      var callbacksToProcess = (state === HIGH ? highCallbacks : lowCallbacks)[pin];
      while (callbacksToProcess.length > 0) {
        callback = callbacksToProcess.pop();
        callback();
      }
      //If we're still waiting for a state change, query pin state again
      if (lowCallbacks[pin].length > 0 || highCallbacks[pin].length > 0) {
        queryPinState(pin);
      }
    },
    pushCallback: function (pin, state, callback) {
      (state === HIGH ? highCallbacks : lowCallbacks)[pin].push(callback);
    }
  };

  function init() {

    for (var i = 0; i < 16; i++) {
      var output = new Uint8Array([REPORT_DIGITAL | i, 0x01]);
      device.send(output.buffer);
    }

    queryCapabilities();

    // TEMPORARY WORKAROUND
    // Since _deviceRemoved is not used with Serial devices
    // ping device regularly to check connection
    pinger = setInterval(function() {
      if (pinging) {
        if (++pingCount > 6) {
          clearInterval(pinger);
          pinger = null;
          connected = false;
          if (device) {
            device.close();
          }
          device = null;
          return;
        }
      } else {
        if (!device) {
          clearInterval(pinger);
          pinger = null;
          return;
        }
        queryFirmware();
        pinging = true;
      }
    }, 100);
  }

  function hasCapability(pin, mode) {
    if (pinModes[mode].indexOf(pin) > -1)
      return true;
    else
      return false;
  }

  function queryFirmware() {
    var output = new Uint8Array([START_SYSEX, QUERY_FIRMWARE, END_SYSEX]);
    device.send(output.buffer);
  }

  function queryCapabilities() {
    console.log('Querying ' + device.id + ' capabilities');
    var msg = new Uint8Array([
        START_SYSEX, CAPABILITY_QUERY, END_SYSEX]);
    device.send(msg.buffer);
  }

  function queryAnalogMapping() {
    console.log('Querying ' + device.id + ' analog mapping');
    var msg = new Uint8Array([
        START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX]);
    device.send(msg.buffer);
  }
  
  function queryPinState(pin) {
    var msg = new Uint8Array([START_SYSEX, PIN_STATE_QUERY, pin, END_SYSEX]);
    device.send(msg.buffer);
  }

  function setDigitalInputs(portNum, portData) {
    digitalInputData[portNum] = portData;
  }

  function setAnalogInput(pin, val) {
    analogInputData[pin] = val;
  }

  function setVersion(major, minor) {
    majorVersion = major;
    minorVersion = minor;
  }

  function processSysexMessage() {
    switch(storedInputData[0]) {
      case CAPABILITY_RESPONSE:
        for (var i = 1, pin = 0; pin < MAX_PINS; pin++) {
          while (storedInputData[i++] != 0x7F) {
            pinModes[storedInputData[i-1]].push(pin);
            i++; //Skip mode resolution
          }
          //initialise callback queues for pin state 
          pinStates.lowCallbacks[pin] = [];
          pinStates.highCallbacks[pin] = [];
          if (i == sysexBytesRead) break;
        }
        queryAnalogMapping();
        break;
      case ANALOG_MAPPING_RESPONSE:
        for (var pin = 0; pin < analogChannel.length; pin++)
          analogChannel[pin] = 127;
        for (var i = 1; i < sysexBytesRead; i++) {
          analogChannel[i-1] = storedInputData[i];
          //initialise callback queue for analog pin number
          console.log('pushing callback ' + storedInputData[i]);
          analogReadCallbacks[storedInputData[i]] = [];
        }
        for (var pin = 0; pin < analogChannel.length; pin++) {
          if (analogChannel[pin] != 127) {
            var out = new Uint8Array([
                REPORT_ANALOG | analogChannel[pin], 0x01]);
            device.send(out.buffer);
          }
        }
        notifyConnection = true;
        setTimeout(function() {
          notifyConnection = false;
        }, 100);
        break;
      case QUERY_FIRMWARE:
        if (!connected) {
          clearInterval(poller);
          poller = null;
          clearTimeout(watchdog);
          watchdog = null;
          connected = true;
          setTimeout(init, 200);
        }
        pinging = false;
        pingCount = 0;
        break;
      case PIN_STATE_RESPONSE:
        var pin = storedInputData[1],
            state = storedInputData[3];
        pinStates.processCallbacks(pin, state);
        break;
    }
  }

  function processInput(inputData) {
    for (var i=0; i < inputData.length; i++) {
      if (parsingSysex) {
        if (inputData[i] == END_SYSEX) {
          parsingSysex = false;
          processSysexMessage();
        } else {
          storedInputData[sysexBytesRead++] = inputData[i];
        }
      } else if (waitForData > 0 && inputData[i] < 0x80) {
        storedInputData[--waitForData] = inputData[i];
        if (executeMultiByteCommand !== 0 && waitForData === 0) {
          switch(executeMultiByteCommand) {
            case DIGITAL_MESSAGE:
              setDigitalInputs(multiByteChannel, (storedInputData[0] << 7) + storedInputData[1]);
              break;
            case ANALOG_MESSAGE:
              setAnalogInput(multiByteChannel, (storedInputData[0] << 7) + storedInputData[1]);
              //console.log(analogReadCallbacks);
              while (analogReadCallbacks[multiByteChannel] !== undefined && 
                  analogReadCallbacks[multiByteChannel].length > 0) {
                //Call all callback functions with new data
                console.log('function called');
                console.log(analogReadCallbacks);
                analogReadCallbacks[multiByteChannel].pop()((storedInputData[0] << 7) + storedInputData[1]);
              }
              break;
            case REPORT_VERSION:
              setVersion(storedInputData[1], storedInputData[0]);
              break;
          }
        }
      } else {
        if (inputData[i] < 0xF0) {
          command = inputData[i] & 0xF0;
          multiByteChannel = inputData[i] & 0x0F;
        } else {
          command = inputData[i];
        }
        switch(command) {
          case DIGITAL_MESSAGE:
          case ANALOG_MESSAGE:
          case REPORT_VERSION:
            waitForData = 2;
            executeMultiByteCommand = command;
            break;
          case START_SYSEX:
            parsingSysex = true;
            sysexBytesRead = 0;
            break;
        }
      }
    }
  }

  function pinMode(pin, mode) {
    var msg = new Uint8Array([PIN_MODE, pin, mode]);
    device.send(msg.buffer);
  }

  //TODO: Change argument order
  function analogRead(pin, callback, enableExtraSensitivity) {
    var mosfetPinState = enableExtraSensitivity ? HIGH : LOW;
    console.log('analogRead');
    if (pin >= 0 && pin < pinModes[ANALOG].length) {
      console.log('analogRead if');
      //Set pin mode in case pin was previously used for digital data
      //(converting analog pin number to digital equivalent)
      pinMode(analogChannel.indexOf(pin), ANALOG);
      //MOSFET for setting sensitivity is on same number digital pin
      // (e.g. A5 set by MOSFET on D5)
      digitalWrite(pin, mosfetPinState);
      //Wait for digitalWrite to succede and switch MOSFET
      //FIXME: SUPER UGLY HACK! DO NOT SHIP THIS!!!
      console.log('done digital read');
      console.log('analogRead callback');
      console.log(callback);
      //TODO: Remove if
      if (callback) {
        pinStates.pushCallback(pin, mosfetPinState, function () {
          console.log('pushing callback to pin ' + pin);
          console.log(digitalInputData);
          analogReadCallbacks[pin].push(function (analogPinData) {
            callback(Math.round((analogPinData * 100) / 1023));
          });
        });
      }
      
      return Math.round((analogInputData[pin] * 100) / 1023);
    } else {
      var valid = [];
      for (var i = 0; i < pinModes[ANALOG].length; i++)
        valid.push(i);
      console.log('ERROR: valid analog pins are ' + valid.join(', '));
    }
  }

  function digitalRead(pin) {
    if (!hasCapability(pin, INPUT)) {
      console.log('ERROR: valid input pins are ' + pinModes[INPUT].join(', '));
      return;
    }
    pinMode(pin, INPUT);
    return (digitalInputData[pin >> 3] >> (pin & 0x07)) & 0x01;
  }

  function analogWrite(pin, val) {
    if (!hasCapability(pin, PWM)) {
      console.log('ERROR: valid PWM pins are ' + pinModes[PWM].join(', '));
      return;
    }
    if (val < 0) val = 0;
    else if (val > 100) val = 100;
    val = Math.round((val / 100) * 255);
    pinMode(pin, PWM);
    var msg = new Uint8Array([
        ANALOG_MESSAGE | (pin & 0x0F),
        val & 0x7F,
        val >> 7]);
    device.send(msg.buffer);
  }

  function digitalWrite(pin, val) {
    if (!hasCapability(pin, OUTPUT)) {
      console.log('ERROR: valid output pins are ' + pinModes[OUTPUT].join(', '));
      return;
    }
    var portNum = (pin >> 3) & 0x0F;
    if (val == LOW)
      digitalOutputData[portNum] &= ~(1 << (pin & 0x07));
    else
      digitalOutputData[portNum] |= (1 << (pin & 0x07));
    pinMode(pin, OUTPUT);
    var msg = new Uint8Array([
        DIGITAL_MESSAGE | portNum,
        digitalOutputData[portNum] & 0x7F,
        digitalOutputData[portNum] >> 0x07]);
    device.send(msg.buffer);
  }

  function rotateServo(pin, deg) {
    if (!hasCapability(pin, SERVO)) {
      console.log('ERROR: valid servo pins are ' + pinModes[SERVO].join(', '));
      return;
    }
    pinMode(pin, SERVO);
    var msg = new Uint8Array([
        ANALOG_MESSAGE | (pin & 0x0F),
        deg & 0x7F,
        deg >> 0x07]);
    device.send(msg.buffer);
  }
  
  function shiftOut(dataPin, clockPin, value) {
    var mask;
    //16-bit output
    for (mask = 0x1; mask < 0x10000; mask <<= 1) {
      //Clock low
      digitalWrite(clockPin, LOW);
      //Write relevant bit
      digitalWrite(dataPin, value & mask);
      //Clock high
      digitalWrite(clockPin, HIGH);
    }
  }
  
  function segmentDisplay(segments, latchPin, secondRegister) {
    var dataPin = 10,
        clockPin = 12;
        //segmentConfigs = [0xB7, 0x82, 0x3B, 0xAB, 0x8E, 0xAD, 0xBC, 0x87, 0xBF, 0x8F];

  /*
    //Validating the number is a finite integer
    if (isNaN(parseInt(number)) || !isFinite(number)) {
     return false;
   }
   //Validating the number is in {0,1,...,9}    
   if (!(number >= 0 && number <= 9)) {
     return false;
   }
   */
    
    digitalWrite(latchPin, LOW);
    //Shift 8 bits to left if necessary to write to second shift register
    //(for second display)
    shiftOut(dataPin, clockPin, segments << (secondRegister ? 0 : 8));
    digitalWrite(latchPin, HIGH);
  }
  
  /* Calculate resistance connected to pin using resistive divider (resistance in kΩ) */
  function readResistiveDivider(pin, resistance, callback) {
    //analogRead returns value between 0 - 100, map to 0-5V
    //FIXME: UGLY HACK ALERT!!
    function calculateResistanceCallback(pinValue) {
      var vIn = 5,
          vOut = pinValue / 20;
      
      //Call callback function with calculated resistance
      callback(resistance / (vIn / vOut - 1));
    }
    analogRead(pin, calculateResistanceCallback, (resistance > 10));
    //analogRead(pin, calculateResistanceCallback);
  }

  ext.whenConnected = function() {
    if (notifyConnection) return true;
    return false;
  };

  ext.analogWrite = function(conn, val) {
    analogWrite(analogConnectionMapping[conn], val);
  };

  //FIXME: mapping
  ext.digitalWrite = function(pin, val) {
    if (val == menus[lang]['outputs'][0])
      digitalWrite(pin, HIGH);
    else if (val == menus[lang]['outputs'][1])
      digitalWrite(pin, LOW);
  };

  ext.analogRead = function(conn, callback) {
    console.log(callback);
    analogRead(analogConnectionMapping[conn], callback);
  };

  //FIXME: mapping
  ext.digitalRead = function(pin) {
    return digitalRead(pin);
  };

  ext.whenAnalogRead = function(conn, op, val) {
    var pin = analogConnectionMapping[conn];
    if (pin >= 0 && pin < pinModes[ANALOG].length) {
      if (op == '>')
        return analogRead(pin) > val;
      else if (op == '<')
        return analogRead(pin) < val;
      else if (op == '=')
        return analogRead(pin) == val;
      else
        return false;
    }
  };

  //FIXME: mapping
  ext.whenDigitalRead = function(pin, val) {
    if (hasCapability(pin, INPUT)) {
      if (val == menus[lang]['outputs'][0])
        return digitalRead(pin);
      else if (val == menus[lang]['outputs'][1])
        return digitalRead(pin) === false;
    }
  };

  ext.connectHW = function(hw, conn) {
    hwList.add(hw, digitalConnectionMapping[conn]);
  };

  ext.rotateServo = function(servo, deg) {
    var hw = hwList.search(servo);
    if (!hw) return;
    if (deg < 0) deg = 0;
    else if (deg > 180) deg = 180;
    rotateServo(hw.pin, deg);
    hw.val = deg;
  };

  ext.changeServo = function(servo, change) {
    var hw = hwList.search(servo);
    if (!hw) return;
    var deg = hw.val + change;
    if (deg < 0) deg = 0;
    else if (deg > 180) deg = 180;
    rotateServo(hw.pin, deg);
    hw.val = deg;
  };

  ext.setLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    analogWrite(hw.pin, val);
    hw.val = val;
  };

  ext.changeLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    var b = hw.val + val;
    if (b < 0) b = 0;
    else if (b > 100) b = 100;
    analogWrite(hw.pin, b);
    hw.val = b;
  };

  ext.digitalLED = function(led, val) {
    var hw = hwList.search(led);
    if (!hw) return;
    if (val == 'on') {
      digitalWrite(hw.pin, HIGH);
      hw.val = 255;
    } else if (val == 'off') {
      digitalWrite(hw.pin, LOW);
      hw.val = 0;
    }
  };

  ext.readInput = function(name, callback) {
    var hw = hwList.search(name);
    if (!hw) return;
    analogRead(hw.pin, callback);
  };

  ext.whenButton = function(btn, state) {
    var hw = hwList.search(btn);
    if (!hw) return;
    if (state === 'pressed')
      return digitalRead(hw.pin);
    else if (state === 'released')
      return !digitalRead(hw.pin);
  };

  ext.isButtonPressed = function(btn) {
    var hw = hwList.search(btn);
    if (!hw) return;
    return digitalRead(hw.pin);
  };

  ext.whenInput = function(name, op, val) {
    var hw = hwList.search(name);
    if (!hw) return;
    if (op == '>')
      return analogRead(hw.pin) > val;
    else if (op == '<')
      return analogRead(hw.pin) < val;
    else if (op == '=')
      return analogRead(hw.pin) == val;
    else
      return false;
  };
  
  /** Display on 7 segment display **/
  ext.firstSegmentDisplay = function (value) {
    var latchPin = 11,
        segmentConfigs = [0x77, 0x14, 0xB3, 0xB6, 0xD4, 0xE6, 0xE7, 0x34, 0xF7, 0xF6];
        
    segmentDisplay(segmentConfigs[value], latchPin, false);
  }
  
  ext.secondSegmentDisplay = function (value) {
    var latchPin = 11,
        segmentConfigs = [0x77, 0x41, 0x3B, 0x6B, 0x4D, 0x6E, 0x7E, 0x43, 0x7F, 0x6F];
    //Shift 8 bits to left to write to second shift register (for second display)
    segmentDisplay(segmentConfigs[value], latchPin, true);
  }
   
  ext.serialOut = function (value) {
    var dataPin = 10,
        clockPin = 12,
        latchPin = 11;
        
    digitalWrite(latchPin, LOW);
    shiftOut(dataPin, clockPin, value);
    digitalWrite(latchPin, HIGH);
  }
  
  ext.calculateResistance = function(sensitivity, conn, callback) {
    
    var pin = analogConnectionMapping[conn];
    //10kΩ resistor for normal, 10kΩ and 1MΩ resistors connected in series for sensitive
    var resistanceInKilohms = (sensitivity === 'normal') ? 10 : 1000 + 10;

    readResistiveDivider(pin, resistanceInKilohms, callback);
  }
   
  ext.mapValues = function(val, aMin, aMax, bMin, bMax) {
    var output = (((bMax - bMin) * (val - aMin)) / (aMax - aMin)) + bMin;
    return Math.round(output);
  };

  ext._getStatus = function() {
    if (!connected)
      return { status:1, msg:'Disconnected' };
    else
      return { status:2, msg:'Connected' };
  };

  ext._deviceRemoved = function(dev) {
    console.log('Device removed');
    // Not currently implemented with serial devices
  };

  var potentialDevices = [];
  ext._deviceConnected = function(dev) {
    potentialDevices.push(dev);
    if (!device)
      tryNextDevice();
  };

  var poller = null;
  var watchdog = null;
  function tryNextDevice() {
    device = potentialDevices.shift();
    if (!device) return;
    //console.log(tryNextDevice.caller);

    device.open({ stopBits: 0, bitRate: 57600, ctsFlowControl: 0 }, function (dev) {
      console.log('Attempting connection with ' + device.id);
      
      if (!dev) {
        //Opening port failed
        console.log('Connection to ' + device.id + ' failed!');
        tryNextDevice();
        return;
      }
      
      device.set_receive_handler(function(data) {
        console.log("set handler");
        var inputData = new Uint8Array(data);
        processInput(inputData);
      });
    });

    poller = setInterval(function() {
      queryFirmware();
    }, 1000);

    watchdog = setTimeout(function() {
      clearInterval(poller);
      poller = null;
      device.set_receive_handler(null);
      device.close();
      device = null;
      tryNextDevice();
    }, 5000);
  }

  ext._shutdown = function() {
    // TODO: Bring all pins down
    if (device) device.close();
    if (poller) clearInterval(poller);
    device = null;
  };

  // Check for GET param 'lang'
  var paramString = window.location.search.replace(/^\?|\/$/g, '');
  var vars = paramString.split("&");
  var lang = 'en';
  for (var i=0; i<vars.length; i++) {
    var pair = vars[i].split('=');
    if (pair.length > 1 && pair[0]=='lang')
      lang = pair[1];
  }

  var blocks = {
    en: [
      ['h', 'when device is connected', 'whenConnected'],
      [' ', 'connect %m.hwOut to %m.voltageConnections', 'connectHW', 'led A', 'EXT1'],
      [' ', 'connect %m.hwIn to %m.resistanceConnections', 'connectHW', 'dial', 'A'],
      ['-'],
      [' ', 'set %m.leds %m.outputs', 'digitalLED', 'led A', 'on'],
      [' ', 'set %m.leds brightness to %n%', 'setLED', 'led A', 100],
      [' ', 'change %m.leds brightness by %n%', 'changeLED', 'led A', 20],
      ['-'],
      [' ', 'rotate %m.servos to %n degrees', 'rotateServo', 'servo A', 180],
      [' ', 'rotate %m.servos by %n degrees', 'changeServo', 'servo A', 20],
      ['-'],
      ['h', 'when %m.buttons is %m.btnStates', 'whenButton', 'button A', 'pressed'],
      ['b', '%m.buttons pressed?', 'isButtonPressed', 'button A'],
      ['-'],
      ['h', 'when %m.hwIn %m.ops %n%', 'whenInput', 'dial', '>', 50],
      ['R', 'read %m.hwIn', 'readInput', 'dial'],
      ['-'],
      [' ', 'set pin %n %m.outputs', 'digitalWrite', 1, 'on'],
      [' ', 'set %m.voltageConnections to %n%', 'analogWrite', 'EXT1', 100],
      //['-'],
      //['h', 'when pin %n is %m.outputs', 'whenDigitalRead', 1, 'on'],
      //['b', 'pin %n on?', 'digitalRead', 1],
      ['-'],
      ['h', 'when %m.connections %m.ops %n%', 'whenAnalogRead', 'A', '>', 50],
      ['R', 'read from %m.connections', 'analogRead', 'A'],
      ['-'],
      ['r', 'map %n from %n %n to %n %n', 'mapValues', 50, 0, 100, -240, 240],
      ['-'],
      [' ', 'show %n on first display', 'firstSegmentDisplay', 1],
      [' ', 'show %n on second display', 'secondSegmentDisplay', 1],
      //[' ', 'write %n to shift register', 'serialOut', 1],
      //[' ', 'show decimal dot on display', 'segmentDisplayDot'],
      //[' ', 'remove decimal dot on display', 'segmentRemoveDot'],
      ['-'],
      ['R', '%m.resistanceSensitivities resistance on %m.resistanceConnections (kΩ)', 
          'calculateResistance', 'normal', 'A']
    ]
  };

  var menus = {
    en: {
      additionalButtons: ['button A', 'button B', 'button C', 'button D'],
      get buttons () { return ['built-in button'].concat(this.additionalButtons); },
      btnStates: ['pressed', 'released'],
      get connections () { return this.resistanceConnections.concat(this.voltageConnections); },
      hwIn: ['dial', 'light sensor', 'temperature sensor'],
      get hwOut () { return this.leds.concat(this.additionalButtons, this.servos); },
      leds: ['led A', 'led B', 'led C', 'led D'],
      outputs: ['on', 'off'],
      ops: ['>', '=', '<'],
      resistanceConnections: ['A', 'B', 'C', 'D'],
      resistanceSensitivities: ['normal', 'sensitive'],
      servos: ['servo A', 'servo B', 'servo C', 'servo D'],
      voltageConnections: ['EXT1', 'EXT2']
    }
  };

  var descriptor = {
    blocks: blocks[lang],
    menus: menus[lang],
    url: 'http://khanning.github.io/scratch-arduino-extension'
  };

  ScratchExtensions.register('Arduino', descriptor, ext, {type:'serial'});

})({});
