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

  constructor(
    platform: DreoPlatform,
    accessory: PlatformAccessory,
    private readonly state: any,
  ) {
    super(platform, accessory);

    this.on = Boolean(state.poweron?.state ?? false);
    this.currentHumidity = Number(state.rh?.state ?? 0);
    this.targetHumidity = Number(state.rhautolevel?.state ?? 50);
    this.mode = Number(state.mode?.state ?? 1);

    // Ensure device is in Auto mode so target humidity applies
    if (this.mode !== 1) {
      this.platform.webHelper.control(this.sn, { mode: 1 });
      this.mode = 1;
    }

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

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetRelativeHumidity)
      .setProps({ minValue: 30, maxValue: 90, minStep: 1 })
      .onSet(this.setTargetRelativeHumidity.bind(this))
      .onGet(this.getTargetRelativeHumidity.bind(this));

    // Limit to Humidifier Only
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(this.getCurrentHumidifierDehumidifierState.bind(this));

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
                this.service
                  .getCharacteristic(this.platform.Characteristic.TargetRelativeHumidity)
                  .updateValue(this.targetHumidity);
                break;
              case 'mode':
                this.mode = Number(data.reported.mode);
                break;
              default:
                break;
            }
          });
        }
      }
    });
  }

  setActive(value: any) {
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

  setTargetRelativeHumidity(value: any) {
    const hum = Math.max(30, Math.min(90, Math.round(Number(value))));
    // Ensure auto mode so rhautolevel is honored
    if (this.mode !== 1) {
      this.platform.webHelper.control(this.sn, { mode: 1 });
      this.mode = 1;
    }
    this.platform.webHelper.control(this.sn, { rhautolevel: hum, poweron: true });
  }

  getTargetRelativeHumidity() {
    return this.targetHumidity;
  }

  getCurrentHumidifierDehumidifierState() {
    // 0: INACTIVE, 1: IDLE, 2: HUMIDIFYING
    if (!this.on) {
      return this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    }
    return this.currentHumidity < this.targetHumidity
      ? this.platform.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING
      : this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE;
  }

  setTargetHumidifierDehumidifierState() {
    // Only HUMIDIFIER is supported; nothing to do
    return;
  }

  getTargetHumidifierDehumidifierState() {
    return this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
  }
}


