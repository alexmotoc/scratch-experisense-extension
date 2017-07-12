#define RES_A 5
#define RES_B 4
#define RES_C 3
#define RES_D 2
#define EXT1 1
#define EXT2 0

#define DIGI_BUTTON 6

#define shiftDataPin 10
#define shiftClockPin 12

int16_t ultrasoundPing = -1;

bool sensitivities[] = {LOW, LOW, LOW, LOW, LOW, LOW};

const byte firstDisplaySegmentConfigs[] {
  0x77, 0x14, 0xB3, 0xB6, 0xD4, 0xE6, 0xE7, 0x34, 0xF7, 0xF6
};

// These need left shifting by 8 to be written to 2nd display
const byte secondDisplaySegmentConfigs[] {
  0x77, 0x41, 0x3B, 0x6B, 0x4D, 0x6E, 0x7E, 0x43, 0x7F, 0x6F
};

// 1: first display, 2: second display: 3: both
byte displayToWrite = 0;

const byte latchPins[] = {13, 11};

void setup() {
  // put your setup code here, to run once:
  Serial.begin(38400);
  pinMode(DIGI_BUTTON, INPUT);
  pinMode(shiftDataPin, OUTPUT);
  pinMode(shiftClockPin, OUTPUT);
  pinMode(latchPins[0], OUTPUT);
  pinMode(latchPins[1], OUTPUT);
}

void loop() {
  // put your main code here, to run repeatedly:
  if (Serial.available()) {
    byte byteRead = Serial.read();
    byte highNybble = (byteRead & 0b11110000) >> 4;
    byte lowNybble = byteRead & 0b00001111;

    // Bitmasks || different vars == no switch :(
    if (displayToWrite) {
      switch (displayToWrite) {
        case 1: writeFirstDisplay(byteRead); break;
        case 2: writeSecondDisplay(byteRead); break;
        case 3: writeTwoDigitDisplay(byteRead); break;
      }
      displayToWrite = 0;
    } else if (byteRead == 0x01) {
      doPicoboard();
    } else {
      if (highNybble == 0b1000) {
        // High bit of lwo nybble is low/high, lower 3 bits is pin
        setSensitivity(lowNybble & 0b0111, lowNybble & 0b1000);
      } else if (highNybble == 0b0100 && lowNybble == 0b0100) {
        // If low nybble is 4 then clear the displays -- no following byte
        //TODO
        clearDisplays();
      } else if (highNybble == 0b0100) {
        // Else low nybble is the display to which to write the numeric value
        // of the next byte
        displayToWrite = lowNybble;
      } else if (highNybble == 0b1100) {
        doUltrasound();
      }

      doExperisense();
    }
  }
}

void doPicoboard() {
  // PicoBoard firmware 'number'
  sendValues(15, 0x04);
  sendValues(0, analogRead(RES_D));
  sendValues(1, analogRead(RES_C));
  sendValues(2, analogRead(RES_B));
  // 0 == HIGH, 1023 == LOW
  sendValues(3, digitalRead(DIGI_BUTTON) ? 0 : 1023);
  sendValues(4, analogRead(RES_A));
  sendValues(5, analogRead(EXT2));
  // No reading for microphone 'cause we don't have one!
  sendValues(6, 0);
  sendValues(7, analogRead(EXT1));
}

void setSensitivity(byte pin, bool sensitivity) {
  // For now we don't want to switch anything for the EXT pins
  if (pin == EXT1 || pin == EXT2) {
    return;
  }
  sensitivities[pin] = sensitivity;
  // MOSFETs for switching sensitivity are on the corresponding
  // digital pin to the analog pin
  digitalWrite(pin, sensitivity);
}

void doExperisense() {
  if (ultrasoundPing == -1) {
    sendValues(7, 0x01);
    sendValues(makeChannel(EXT2, sensitivities[EXT2]), analogRead(EXT2));
    sendValues(makeChannel(EXT1, sensitivities[EXT1]), analogRead(EXT1));
  } else {
    sendValues(7, 0x02);
    sendValues(0, highByte(ultrasoundPing));
    sendValues(1, lowByte(ultrasoundPing));
    ultrasoundPing = -1;
  }

  for (size_t pin = 2; pin <= RES_A; pin++) {
    sendValues(makeChannel(pin, sensitivities[pin]), analogRead(pin));
  }
  sendValues(6, digitalRead(DIGI_BUTTON) ? 0 : 1023);
}

byte makeChannel(byte channel, bool sensitivity) {
  // TODO: rename sensitivity - can also be EXT1/dial, EXT2/light
  // on new board
  // TODO: contrain channel to 0–7
  return sensitivity ? channel | 0b1000 : channel;
}

void sendValues(byte channel, unsigned short value) {
  // Tag high and low bytes with 1 and 0 high bit, respectively
  byte highByte = 0b10000000;
  byte lowByte = 0b00000000;

  // If value has more than 10 bits, keep only the lowest 10
  value &= 0b1111111111;

  // Tag high byte with channel number
  highByte |= channel << 3;

  // Highest 3 bits of value on high byte
  highByte |= value >> 7;
  // Other 7 bits on low byes
  lowByte |= ((byte) value) & 0b01111111;

  Serial.write(highByte);
  delayMicroseconds(400);
  Serial.write(lowByte);
  delayMicroseconds(400);
}

// Using byte argument for writeDisplay funcs because they're unsigned

void writeFirstDisplay(byte num) {
  // Left shift to push bits through 1st shift register
  num = min(num, 9);
  displayShiftOut(firstDisplaySegmentConfigs[num] << 8);
  latchDisplay(1);
}

void digitalWriteToExt(bool channel, bool value) {
  pinMode(channel, OUTPUT);
}

void writeSecondDisplay(byte num) {
  num = min(num, 9);
  displayShiftOut(secondDisplaySegmentConfigs[num]);
  latchDisplay(2);
}

void writeTwoDigitDisplay(byte num) {
  if (num > 99) {
    // '1H' – 0x145C is '1h'
    displayShiftOut(0x145D);
  } else {
    byte firstDigit = (num / 10) % 10;
    byte secondDigit = num % 10;

    displayShiftOut(firstDisplaySegmentConfigs[firstDigit] << 8 | secondDisplaySegmentConfigs[secondDigit]);
  }
  latchDisplay(1);
  latchDisplay(2);
}

void displayShiftOut(uint16_t value) {
  shiftOut(shiftDataPin, shiftClockPin, LSBFIRST, lowByte(value));
  shiftOut(shiftDataPin, shiftClockPin, LSBFIRST, highByte(value));
}

void clearDisplays() {
  // 16 0s
  displayShiftOut(0);
  latchDisplay(1);
  latchDisplay(2);
}

void latchDisplay(byte displayNumber) {
  digitalWrite(latchPins[displayNumber - 1], HIGH);
  digitalWrite(latchPins[displayNumber - 1], LOW);
}

void doUltrasound() {
  // TODO: refer to pins nicely
  const byte ext1 = 15;
  const byte ext2 = 14;
  pinMode(ext1, OUTPUT);
  pinMode(ext2, INPUT);
  delay(1);
  // Send pulse
  digitalWrite(ext1, LOW);
  digitalWrite(ext1, HIGH);
  // Needed?
  delayMicroseconds(10);
  digitalWrite(ext1, LOW);

  // 5m * speed of sound = 15000µs timeout
  ultrasoundPing = pulseIn(ext2, HIGH, 15000);

}
