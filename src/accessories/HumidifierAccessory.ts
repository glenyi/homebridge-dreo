import { Service, PlatformAccessory } from 'homebridge';
import { DreoPlatform } from '../platform';
import { BaseAccessory } from './BaseAccessory';

/**
 * Humidifier Accessory (DR-HHM001S minimal support)
 * - Power: `poweron` (boolean)
 * - Target humidity: `rhautolevel` (0-100) when mode=1 (auto)
 * - Current humidity: `rh` (0-100)
 * For simplicity, we operate in Auto mode and map HomeKit humidity target to `rhautolevel`.
 */
export class HumidifierAccessory extends BaseAccessory {
  private service: Service;

  private on: boolean;
  private currentHumidity: number;
  private targetHumidity: number;
  private mode: number; // 1 = auto, 0 = manual, 2 = sleep
  private humidifierState: number; // 0 = inactive, 1 = idle, 2 = humidifying

  private static minHumidity = 30;
  private static maxHumidity = 90;

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly state,
  ) {
    super(platform, accessory);

    this.on = Boolean(state.poweron?.state ?? false);
    this.currentHumidity = Number(state.rh?.state ?? 0);
    this.targetHumidity = Number(state.rhautolevel?.state ?? 50);
    this.mode = Number(state.mode?.state ?? 1);
    this.humidifierState = Number(state.suspend?.state ?? this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE);

    // Ensure device is in Auto mode so target humidity applies
    if (this.mode !== 1) {
      this.platform.log.debug('Setting device to auto mode for humidity control');
      this.platform.webHelper.control(this.sn, { mode: 1 });
      this.mode = 1;
    }

    // Log current device state for debugging
    this.platform.log.debug('Humidifier device state:', {
      on: this.on,
      currentHumidity: this.currentHumidity,
      targetHumidity: this.targetHumidity,
      mode: this.mode,
      humidifierState: this.humidifierState,
    });

    this.service =
      this.accessory.getService(this.platform.Service.HumidifierDehumidifier) ||
      this.accessory.addService(this.platform.Service.HumidifierDehumidifier);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.deviceName,
    );

    // Required characteristics
    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // Configure RelativeHumidityHumidifierThreshold characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      })
      .onSet(this.setTargetRelativeHumidity.bind(this))
      .onGet(this.getTargetRelativeHumidity.bind(this))
      .updateValue(this.targetHumidity);

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(this.getCurrentHumidifierDehumidifierState.bind(this))
      .updateValue(this.humidifierState);

    // Limit to Humidifier Only
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
      .setProps({ validValues: [this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER] })
      .onSet(this.setTargetHumidifierDehumidifierState.bind(this))
      .onGet(this.getTargetHumidifierDehumidifierState.bind(this));

    // Subscribe to websocket updates
    platform.webHelper.addEventListener('message', (message) => {
      const data = JSON.parse(message.data);
      if (data.devicesn === accessory.context.device.sn) {
        if (data.method === 'control-report' || data.method === 'control-reply' || data.method === 'report') {
          Object.keys(data.reported).forEach((key) => {
            switch (key) {
              case 'poweron':
                this.on = Boolean(data.reported.poweron);
                this.service
                  .getCharacteristic(this.platform.Characteristic.Active)
                  .updateValue(this.on);
                break;
              case 'rh':
                this.currentHumidity = Number(data.reported.rh);
                this.service
                  .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
                  .updateValue(this.currentHumidity);
                break;
              case 'rhautolevel':
                this.targetHumidity = Number(data.reported.rhautolevel);
                this.platform.log.debug(`Websocket update: rhautolevel changed to ${this.targetHumidity}%`);
                this.service
                  .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
                  .updateValue(this.targetHumidity);
                break;
              case 'mode':
                this.mode = Number(data.reported.mode);
                this.platform.log.debug(`Reported mode: ${this.mode}`);
                break;
              case 'suspend':
                this.platform.log.debug(`Reported suspend: ${data.reported.suspend}`);
                this.humidifierState = data.reported.suspend
                  ? this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE
                  : this.platform.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING;
                this.service
                  .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
                  .updateValue(this.humidifierState);
                break;
              default:
                break;
            }
          });
        }
      }
    });
  }

  setActive(value) {
    const desired = Boolean(value);
    if (this.on !== desired) {
      this.platform.webHelper.control(this.sn, { poweron: desired });
    }
  }

  getActive() {
    return this.on;
  }

  getCurrentRelativeHumidity() {
    return this.currentHumidity;
  }

  setTargetRelativeHumidity(value) {
    const hum = Math.min(HumidifierAccessory.maxHumidity, Math.max(HumidifierAccessory.minHumidity, Math.round(Number(value))));
    this.platform.log.debug(`Setting target humidity to ${hum}% (clamped from ${value})`);

    // Ensure auto mode so rhautolevel is honored
    if (this.mode !== 1) {
      this.platform.log.debug('Switching to auto mode for humidity control');
      this.platform.webHelper.control(this.sn, { mode: 1 });
      this.mode = 1;
    }

    // Update the device with the new target humidity
    this.platform.webHelper.control(this.sn, { rhautolevel: hum });
    this.platform.log.debug(`Target humidity updated to ${hum}%`);
  }

  getTargetRelativeHumidity() {
    this.platform.log.debug(`Getting target humidity: ${this.targetHumidity}%`);
    return this.targetHumidity;
  }

  getCurrentHumidifierDehumidifierState() {
    // 0: INACTIVE, 1: IDLE, 2: HUMIDIFYING
    if (!this.on) {
      this.platform.log.debug('Current state: INACTIVE');
      return this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    }

    // If suspend is true, set to IDLE
    if (this.humidifierState === 1) {
      this.platform.log.debug('Current state: IDLE (suspended)');
      return this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE;
    }

    // If suspend is false, set to HUMIDIFYING
    this.platform.log.debug('Current state: HUMIDIFYING');
    return this.platform.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING;
  }

  setTargetHumidifierDehumidifierState() {
    // Only HUMIDIFIER is supported
    return this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
  }

  getTargetHumidifierDehumidifierState() {
    return this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
  }
}


