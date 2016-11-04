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

  var lang = 'en';
  (function () {
    // Check for GET param 'lang'
    var paramString = window.location.search.replace(/^\?|\/$/g, ''),
        vars = paramString.split("&"),
        pair,
        i;
    for (i=0; i<vars.length; i++) {
      pair = vars[i].split('=');
      if (pair.length > 1 && pair[0]=='lang') {
        lang = pair[1];
      }
    }
  }());

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
  
  var DISPLAY_WRITE_DELAY = 100;
    
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
  var device = null;
  
  var analogReadCallbacks = [];
  
  var analogConnectionMapping = {
    A: 5,
    B: 4,
    C: 3,
    D: 2,
    EXT1: 1,
    EXT2: 0
  };
  
  var digitalConnectionMapping = {};
  
  for (var conn in analogConnectionMapping) {
    if (analogConnectionMapping.hasOwnProperty(conn)) {
      //Analog pins start at 14 in digital numbering scheme
      digitalConnectionMapping[conn] = analogConnectionMapping[conn] + 14;
    }
  }

  // TEMPORARY WORKAROUND
  // Since _deviceRemoved is not used with Serial devices
  // ping device regularly to check connection
  var pinging = false;
  var pingCount = 0;
  var pinger = null;

  var hwList = {
    'built-in button': {pin: 6},
    'light sensor': {pin: 0, scalingFunc: function (value) {
      value = 1023 - value;
      return (value < 25) ? 100 - value : Math.round((1023 - value) * (75 / 998));
    }},
    'dial': {pin: 1, scalingFunc: function (value) {
      return 100 - scaleValue(value);
    }}
  };
  
  var pinStates = {
    lowCallbacks: [],
    highCallbacks: [],
    processCallbacks: function (pin, state) {
      console.log('processing callbacks');
      console.log(this.highCallbacks);
      console.log(this.lowCallbacks);
      var callback,
          callbacksToProcess = this[(state === HIGH ? 'highCallbacks' : 'lowCallbacks')][pin];
      while (callbacksToProcess.length > 0) {
        callback = callbacksToProcess.pop();
        callback();
      }
      //If we're still waiting for a state change, query pin state again
      if (this.lowCallbacks[pin].length > 0 || this.highCallbacks[pin].length > 0) {
        queryPinState(pin);
      }
    },
    pushCallback: function (pin, state, callback) {
      this[(state === HIGH ? 'highCallbacks' : 'lowCallbacks')][pin].push(callback);
      //Do query
      queryPinState(pin);
    }
  };
  
  var segmentDisplays = {
    firstDisplaySegmentConfigs: [0x7700, 0x1400, 0xB300, 0xB600, 0xD400, 0xE600, 0xE700,
      0x3400, 0xF700, 0xF600],
    secondDisplaySegmentConfigs: [0x77, 0x41, 0x3B, 0x6B, 0x4D, 0x6E, 0x7E, 0x43, 0x7F, 0x6F],
    clearDisplays: function () {
      this.shiftOut(0);
      this.latch(1);
      this.latch(2);
    },
    test: function() {
      //Flash 88 on screen
      var that = this,
          flashSpeed = 100;
      setTimeout(function () {
        that.clearDisplays()
        setTimeout(function () {
          that.writeTwoDigitDisplay(88);
          setTimeout(function () {
            that.clearDisplays();
            setTimeout(function () {
              that.writeTwoDigitDisplay(88);
            }, flashSpeed);
          }, flashSpeed);
        }, flashSpeed);
      }, 0);
    },
    writeFirstDisplay: function (num) {
      this.shiftOut(this.firstDisplaySegmentConfigs[num]);
      this.latch(1);
    },
    writeSecondDisplay: function (num) {
      this.shiftOut(this.secondDisplaySegmentConfigs[num]);
      this.latch(2);
    },
    writeTwoDigitDisplay: function (num) {
      //tens on first display
      var firstDisplayDigit = Math.floor(num / 10) % 10,
          //units on second display
          secondDisplayDigit = num % 10,
          segmentConfig = this.firstDisplaySegmentConfigs[firstDisplayDigit] |
            this.secondDisplaySegmentConfigs[secondDisplayDigit];
      
      this.shiftOut(segmentConfig);
      this.latch(1);
      this.latch(2);
    },
    shiftOut: function (value) {
      var mask,
        dataPin = 10,
        clockPin = 12;
      //16-bit output
      for (mask = 0x1; mask < 0x10000; mask <<= 1) {
        //Clock low
        digitalWrite(clockPin, LOW);
        //Write relevant bit
        digitalWrite(dataPin, value & mask);
        //Clock high
        digitalWrite(clockPin, HIGH);
      }
    },
    latch: function (displayNumber) {
      var firstDisplayLatchPin = 13,
          secondDisplayLatchPin = 11,
          latchPin = displayNumber === 1 ? firstDisplayLatchPin : secondDisplayLatchPin;
          
      digitalWrite(latchPin, HIGH);
      digitalWrite(latchPin, LOW);
    }
  };
  
  var servos = {
    currentPositions: {},
    calculateRotationPosition: function (conn, changeInDegrees) {
      //If no position recorded, servo hasn't moved yet – assume starting position of 0
      var currentPosition = this.currentPositions[conn] || 0,
          newPosition = currentPosition + changeInDegrees;
      
      return this.constrainRotation(newPosition);
    },
    constrainRotation: function (rotationInDegrees) {
      //Constrain to 0–180 degrees (range of servo)
      return Math.min(Math.max(rotationInDegrees, 0), 180);
    },
    rotateBy: function (conn, deg) {
      var pin = digitalConnectionMapping[conn],
          newPosition = this.calculateRotationPosition(conn, deg);
          
      this.currentPositions[conn] = newPosition;
      this.writeOut(pin, newPosition);
    },
    rotateTo: function (conn, deg) {
      var pin = digitalConnectionMapping[conn],
          newPosition = this.constrainRotation(deg);
      
      this.currentPositions[conn] = newPosition;
      this.writeOut(pin, newPosition);
    },
    writeOut: function (pin, deg) {
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
  };
  
  function analogPinNumberToDigital(analogPin) {
    //Set pin mode in case pin was previously used for digital data
    //(converting analog pin number to digital equivalent)
    //indexOf() for typed arrays only works in Firefox :(
    var digitalPinEquivalent = -1;
    if (analogPin >= analogChannel.size) {
      throw new RangeError("Attempted to convert non-existant analog pin to digital equivalent");
    }
    while (analogChannel[++digitalPinEquivalent] !== analogPin)
        ;
    return digitalPinEquivalent;
  }

  function init() {
    console.log('init');
    for (var i = 0; i < 16; i++) {
      var output = new Uint8Array([REPORT_DIGITAL | i, 0x01]);
      device.send(output.buffer);
    }

    queryCapabilities();
    
    segmentDisplays.test();

    // TEMPORARY WORKAROUND
    // Since _deviceRemoved is not used with Serial devices
    // ping device regularly to check connection
    pinger = setInterval(function() {
      if (pinging) {
        if (++pingCount > 6) {
          console.log('pingCount > 6');
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
    }, 1000);
  }

  function hasCapability(pin, mode) {
    if (pinModes[mode].indexOf(pin) > -1)
      return true;
    else
      return false;
  }

  function queryFirmware() {
    console.log('Querying firmware');
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
    console.log('querying pin state');
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
    var i,
        pin,
        state,
        out;
    switch(storedInputData[0]) {
      case CAPABILITY_RESPONSE:
        for (i = 1, pin = 0; pin < MAX_PINS; pin++) {
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
        for (pin = 0; pin < analogChannel.length; pin++)
          analogChannel[pin] = 127;
        for (i = 1; i < sysexBytesRead; i++) {
          analogChannel[i-1] = storedInputData[i];
          //initialise callback queue for analog pin number
          console.log('pushing callback ' + storedInputData[i]);
          analogReadCallbacks[storedInputData[i]] = [];
        }
        for (pin = 0; pin < analogChannel.length; pin++) {
          if (analogChannel[pin] != 127) {
            out = new Uint8Array([
              REPORT_ANALOG | analogChannel[pin], 0x01]);
            device.send(out.buffer);
          }
        }
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
        console.log('pin state response');
        state = storedInputData[3];
        pin = storedInputData[1];
        pinStates.processCallbacks(pin, state);
        break;
    }
  }

  function processInput(inputData) {
    var command,
        i;
    for (i = 0; i < inputData.length; i++) {
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
  
  function scaleValue(value) {
    return Math.round((value / 1024) * 100);
  }

  function pinMode(pin, mode) {
    var msg = new Uint8Array([PIN_MODE, pin, mode]);
    device.send(msg.buffer);
  }

  function rawAnalogRead(pin, sensitivity, callback) {
    var digitalPinEquivalent = analogPinNumberToDigital(pin),
        mosfetPinState = (sensitivity === 'sensitive') ? HIGH : LOW,
        switchingEnabled = (pin !== analogConnectionMapping.EXT1 && 
          pin !== analogConnectionMapping.EXT2);
          
    function pushAnalogReadCallback() {
      analogReadCallbacks[pin].push(callback);
    }
        
    console.log('analogRead');
    if (pin >= 0 && pin < pinModes[ANALOG].length) {
      console.log('analogRead if');

      pinMode(digitalPinEquivalent, ANALOG);
      //Don't try switching for voltage inputs - nothing to switch!
      if (switchingEnabled) {
        //MOSFET for setting sensitivity is on same number digital pin
        // (e.g. A5 set by MOSFET on D5)
        digitalWrite(pin, mosfetPinState);
      }
      console.log('done digital read');
      console.log('analogRead callback');
      console.log(callback);
      //TODO: Remove if
      if (callback) {
        if (switchingEnabled) {
          pinStates.pushCallback(pin, mosfetPinState, pushAnalogReadCallback);
        } else {
          pushAnalogReadCallback();
        }
      }
      
      return analogInputData[pin];
    } else {
      var valid = [];
      for (var i = 0; i < pinModes[ANALOG].length; i++)
        valid.push(i);
      console.log('ERROR: valid analog pins are ' + valid.join(', '));
    }
  }
  
  function analogRead(pin, sensitivity, callback) {
    //Return value immediately and also pass callback
    return scaleValue(rawAnalogRead(pin, sensitivity, function (value) {
      callback(scaleValue(value));
    }));
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
    var msg;
    if (!hasCapability(pin, PWM)) {
      console.log('ERROR: valid PWM pins are ' + pinModes[PWM].join(', '));
      return;
    }
    if (val < 0) val = 0;
    else if (val > 100) val = 100;
    val = Math.round((val / 100) * 255);
    pinMode(pin, PWM);
    msg = new Uint8Array([
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
  
  /* Calculate resistance connected to pin using resistive divider (resistance in kΩ) */
  function readResistiveDivider(pin, sensitivity, callback) {
    //analogRead returns value between 0 - 1023, map to 0-5V
    function calculateResistanceCallback(pinValue) {
      var resistance = sensitivityToKilohms(sensitivity),
          vIn = 5,
          vOut = pinValue / 1023 * 5;
      
      //Call callback function with calculated resistance
      callback(resistance / (vIn / vOut - 1));
    }
    rawAnalogRead(pin, sensitivity, calculateResistanceCallback);
    //analogRead(pin, calculateResistanceCallback);
  }
  
  function sensitivityToKilohms(sensitivity) {
    //10kΩ resistor for normal, 10kΩ and 1MΩ resistors connected in series for sensitive
    return (sensitivity === 'normal') ? 10 : 1000 + 10;
  }

  ext.analogWrite = function(conn, val) {
    analogWrite(analogConnectionMapping[conn], val);
  };

  ext.analogRead = function (sensitivity, conn, callback) {
    analogRead(analogConnectionMapping[conn], sensitivity, callback);
  };
  
  ext.analogReadVoltage = function (conn, callback) {
    analogRead(analogConnectionMapping[conn], null, callback);
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

  ext.readInput = function(name, callback) {
    var hw = hwList[name],
        scalingFunc;
    if (!hw) return;
    scalingFunc = hw.scalingFunc || scaleValue;
    rawAnalogRead(hw.pin, 'normal', function (value) {
      callback(scalingFunc(value));
    });
  };

  ext.whenButton = function(btn, state) {
    var pin = analogConnectionMapping[btn] || hwList[btn].pin;
    if (pin === undefined) return;
    if (state === 'pressed')
      return digitalRead(pin);
    else if (state === 'released')
      return !digitalRead(pin);
  };

  ext.isButtonPressed = function(btn) {
    var pin = analogConnectionMapping[btn] || hwList[btn].pin;
    if (pin === undefined) return;
    return digitalRead(pin);
  };

  ext.whenInput = function(name, op, val) {
    var scaledValue,
        hw = hwList[name];
    if (!hw) return;
    scaledValue = hw.scalingFunc ? hw.scalingFunc(analogRead(hw.pin)) : analogRead(hw.pin);
    if (op == '>')
      return scaledValue > val;
    else if (op == '<')
      return scaledValue < val;
    else if (op == '=')
      return scaledValue == val;
    else
      return false;
  };
  
  ext.rotateServo = function (conn, deg) {
    servos.rotateTo(conn, deg);
  };
  
  ext.changeServo = function (conn, deg) {
    servos.rotateBy(conn, deg);
  };
  
  /** Display on 7 segment display **/
  ext.firstSegmentDisplay = function (value, callback) {
    segmentDisplays.writeFirstDisplay(value);
    setTimeout(callback, DISPLAY_WRITE_DELAY);
  };
  
  ext.secondSegmentDisplay = function (value, callback) {
    segmentDisplays.writeSecondDisplay(value);
    setTimeout(callback, DISPLAY_WRITE_DELAY);
  };
  
  ext.twoDigitSegmentDisplay = function (value, callback) {
    segmentDisplays.writeTwoDigitDisplay(value);
    setTimeout(callback, DISPLAY_WRITE_DELAY);
  };
  
  ext.clearDisplays = function (callback) {
    segmentDisplays.clearDisplays();
    setTimeout(callback, DISPLAY_WRITE_DELAY);
  };
  
  ext.calculateResistance = function (sensitivity, conn, callback) {
    var pin = analogConnectionMapping[conn];
    
    readResistiveDivider(pin, sensitivity, callback);
  };
  
  ext.calculateVoltage = function (conn, callback) {
    rawAnalogRead(analogConnectionMapping[conn], null, function (pinValue) {
      //Scale 0–1023 reading to 0–5 V
      callback(pinValue / 1023 * 5);
    });
  };
   
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
    console.log('assigning device');
    console.log(device);
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
        //console.log("handler");
        var inputData = new Uint8Array(data);
        /*var str = "";
        for (var i = 0; i < inputData.length; i++) {
          str += inputData[i].toString(16) + ' ';
        }
        console.log(str);*/
        processInput(inputData);
      });
    });
      
    poller = setInterval(function() {
      queryFirmware();
    }, 1000);

    watchdog = setTimeout(function() {
      console.log('watchdog ran');
      clearInterval(poller);
      poller = null;
      device.set_receive_handler(null);
      device.close();
      device = null;
      tryNextDevice();
    }, 5000);
  }

  ext._shutdown = function() {
    console.log('shutdown');
    // TODO: Bring all pins down
    if (device) device.close();
    if (poller) clearInterval(poller);
    device = null;
  };

  var blocks = {
    en: [
      ['h', 'when %m.buttons is %m.btnStates', 'whenButton', 'built-in button', 'pressed'],
      ['b', '%m.buttons pressed?', 'isButtonPressed', 'built-in button'],
      ['-'],
      ['h', 'when %m.hwIn %m.ops %n%', 'whenInput', 'dial', '>', 50],
      ['R', 'read %m.hwIn', 'readInput', 'dial'],
      ['-'],
      [' ', 'set %m.voltageConnections to %n%', 'analogWrite', 'EXT1', 100],
      ['-'],
      [' ', 'rotate servo on %m.voltageConnections to %n degrees', 'rotateServo', 'EXT1', 180],
      [' ', 'rotate servo on %m.voltageConnections by %n degrees', 'changeServo', 'EXT1', 20],
      ['-'],
      ['h', 'when %m.connections %m.ops %n%', 'whenAnalogRead', 'A', '>', 50],
      ['R', '%m.resistanceSensitivities read from %m.resistanceConnections', 'analogRead',
         'normal', 'A'],
      ['R', 'read from %m.voltageConnections', 'analogReadVoltage', 'EXT1'],
      ['-'],
      ['r', 'map %n from %n %n to %n %n', 'mapValues', 50, 0, 100, -240, 240],
      ['-'],
      ['w', 'show %n on first display', 'firstSegmentDisplay', 1],
      ['w', 'show %n on second display', 'secondSegmentDisplay', 1],
      ['w', 'display two-digit number %n', 'twoDigitSegmentDisplay', 10],
      ['w', 'clear displays', 'clearDisplays'],
      ['-'],
      ['R', '%m.resistanceSensitivities resistance on %m.resistanceConnections (kΩ)', 
          'calculateResistance', 'normal', 'A'],
      ['R', 'voltage on %m.voltageConnections (V)', 'calculateVoltage', 'EXT1']
    ]
  };

  var menus = {
    en: {
      get buttons() { return ['built-in button'].concat(this.resistanceConnections); },
      btnStates: ['pressed', 'released'],
      get connections() { return this.resistanceConnections.concat(this.voltageConnections); },
      hwIn: Object.keys(hwList),
      outputs: ['on', 'off'],
      ops: ['>', '=', '<'],
      resistanceConnections: ['A', 'B', 'C', 'D'],
      resistanceSensitivities: ['normal', 'sensitive'],
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
