'use strict';

const libQ = require('kew');
const path = require('path');
const net = require('net');
const io = require('socket.io-client');
const conf = new (require('v-conf'))();

const CONFIG_FILE = path.join(__dirname, 'config.json');
const SOURCE_CODES = {
  'Phono': 0x01,
  'AUX': 0x02,
  'PVR': 0x03,
  'AV': 0x04,
  'STB': 0x05,
  'CD': 0x06,
  'BD': 0x07,
  'SAT': 0x08
};
const SOURCE_NAMES = {
  0x01: 'Phono',
  0x02: 'AUX',
  0x03: 'PVR',
  0x04: 'AV',
  0x05: 'STB',
  0x06: 'CD',
  0x07: 'BD',
  0x08: 'SAT'
};

module.exports = ArcamSa20Plugin;

function ArcamSa20Plugin(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.socket = null;
  this.prevPlaybackStatus = null;
  this.didAutoPowerOnForCurrentPlay = false;
  this.liveStatusTimer = null;
  this.liveStatusBusy = false;
  this.lastPublishedVolume = null;
  this.lastPublishedMute = null;
  this.currentPlaybackStatus = null;
  this.playAutomationRunning = false;
  this.cachedVolume = 30;
  this.cachedMute = false;
  this.idlePowerOffTimer = null;
  this.ampUnavailableStopTimer = null;
  this.nativeVolumeSettings = null;
}

ArcamSa20Plugin.prototype.onVolumioStart = function() {
  return libQ.resolve();
};

ArcamSa20Plugin.prototype.getConfigurationFiles = function() {
  return ['config.json'];
};

ArcamSa20Plugin.prototype.onStart = function() {
  const defer = libQ.defer();
  try {
    conf.loadFile(CONFIG_FILE);
    this.cachedVolume = this._clampInt(conf.get('lastVolume'), 0, 99, this._clampInt(conf.get('playVolume'), 0, 99, 30));
    this.cachedMute = conf.get('lastMute') === 'Muted';
    this._activateSocketIO();
    this.initVolumeSettings()
      .then(() => this.queryStatusSilent())
      .then(() => {
        setTimeout(() => {
          this.initVolumeSettings().fail(() => libQ.resolve());
        }, 4000);
        setTimeout(() => {
          this.initVolumeSettings().fail(() => libQ.resolve());
        }, 12000);
        setTimeout(() => {
          this.initVolumeSettings().fail(() => libQ.resolve());
        }, 25000);
        this._startLiveStatusTimer();
        this._log('started');
        defer.resolve();
      })
      .fail((err) => {
        this._log('start warning: ' + err.message);
        defer.resolve();
      });
  } catch (e) {
    defer.reject(e);
  }
  return defer.promise;
};

ArcamSa20Plugin.prototype.onStop = function() {
  this._cancelIdlePowerOffTimer();
  this._stopLiveStatusTimer();
  if (this.socket) {
    try {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    } catch (e) {
      // ignore
    }
    this.socket = null;
  }
  return this.resetVolumeSettings();
};

ArcamSa20Plugin.prototype.onRestart = function() {
  return libQ.resolve();
};

ArcamSa20Plugin.prototype.getUIConfig = function() {
  const defer = libQ.defer();
  const langCode = this.commandRouter.sharedVars.get('language_code');

  this.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + langCode + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json')
  ).then((uiconf) => {
    this._setUIValue(uiconf, 'host', conf.get('host'));
    this._setUIValue(uiconf, 'port', conf.get('port'));
    this._setUIValue(uiconf, 'timeoutMs', conf.get('timeoutMs'));

    this._setUIValue(uiconf, 'autoPowerOnPlay', conf.get('autoPowerOnPlay'));
    this._setUIValue(uiconf, 'switchSourceOnPlay', conf.get('switchSourceOnPlay'));
    this._setUIValue(uiconf, 'playSource', conf.get('playSource'));
    this._setUIValue(uiconf, 'setVolumeOnPlay', conf.get('setVolumeOnPlay'));
    this._setUIValue(uiconf, 'playVolume', conf.get('playVolume'));
    this._setUIValue(uiconf, 'powerOnDelayMs', conf.get('powerOnDelayMs'));
    this._setUIValue(uiconf, 'autoPowerOffOnIdle', conf.get('autoPowerOffOnIdle'));
    this._setUIValue(uiconf, 'idlePowerOffDelaySec', conf.get('idlePowerOffDelaySec'));
    this._setUIValue(uiconf, 'debugLogging', conf.get('debugLogging'));

    this._setUIValue(uiconf, 'manualSource', conf.get('playSource'));
    this._setUIValue(uiconf, 'manualVolume', this._clampInt(conf.get('lastVolume'), 0, 99, conf.get('playVolume')));
    this._setUIValue(uiconf, 'manualBalance', this._balanceStringToInt(conf.get('lastBalance')));

    this._setUIValue(uiconf, 'statusSummary', conf.get('statusSummary'));
    defer.resolve(uiconf);
  }).fail((err) => defer.reject(err));

  return defer.promise;
};

ArcamSa20Plugin.prototype.saveConnectionConfig = function(data) {
  conf.set('host', String(data.host || '').trim());
  conf.set('port', this._clampInt(data.port, 1, 65535, 50000));
  conf.set('timeoutMs', this._clampInt(data.timeoutMs, 500, 20000, 3000));
  setTimeout(() => {
    this.initVolumeSettings().fail(() => libQ.resolve());
  }, 500);
  this._toast('success', 'ARCAM SA20', 'Connection settings saved');
  return libQ.resolve();
};

ArcamSa20Plugin.prototype.saveBehaviorConfig = function(data) {
  conf.set('autoPowerOnPlay', !!data.autoPowerOnPlay);
  conf.set('switchSourceOnPlay', !!data.switchSourceOnPlay);
  conf.set('playSource', this._normalizeSourceSelection(data.playSource, conf.get('playSource') || 'CD'));
  conf.set('setVolumeOnPlay', !!data.setVolumeOnPlay);
  conf.set('playVolume', this._clampInt(data.playVolume, 0, 99, 30));
  conf.set('powerOnDelayMs', this._clampInt(data.powerOnDelayMs, 0, 15000, 3500));
  conf.set('autoPowerOffOnIdle', !!data.autoPowerOffOnIdle);
  conf.set('idlePowerOffDelaySec', this._clampInt(data.idlePowerOffDelaySec, 1, 86400, 900));
  conf.set('debugLogging', !!data.debugLogging);
  setTimeout(() => {
    this.initVolumeSettings().fail(() => libQ.resolve());
  }, 500);
  this._toast('success', 'ARCAM SA20', 'Playback automation settings saved');
  return libQ.resolve();
};

ArcamSa20Plugin.prototype.testConnection = function() {
  return this._connectOnly()
    .then(() => {
      this._toast('success', 'ARCAM SA20', 'TCP connection successful');
    })
    .fail((err) => {
      this._toast('error', 'ARCAM SA20', 'TCP connection failed: ' + err.message);
      throw err;
    });
};

ArcamSa20Plugin.prototype.queryStatus = function() {
  return this.queryStatusSilent()
    .then(() => {
      this._toast('success', 'ARCAM SA20', 'Amplifier status refreshed');
    })
    .fail((err) => {
      this._toast('error', 'ARCAM SA20', 'Status query failed: ' + err.message);
      throw err;
    });
};

ArcamSa20Plugin.prototype.queryStatusSilent = function() {
  return this._pollStatusAndReflect();
};

ArcamSa20Plugin.prototype.powerOn = function() {
  return this._sendCommand(0x00, [0x01]).then(() => this.queryStatusSilent());
};

ArcamSa20Plugin.prototype.powerOff = function() {
  return this._sendCommand(0x00, [0x00]).then(() => this.queryStatusSilent());
};

ArcamSa20Plugin.prototype.muteToggle = function() {
  return this._sendCommand(0x0E, [0x02])
    .then(() => this.queryStatusSilent())
    .then(() => this.getVolumeObject());
};

ArcamSa20Plugin.prototype.volumeUp = function() {
  return this._sendCommand(0x0D, [0xF1])
    .then(() => this.queryStatusSilent())
    .then(() => this.getVolumeObject());
};

ArcamSa20Plugin.prototype.volumeDown = function() {
  return this._sendCommand(0x0D, [0xF2])
    .then(() => this.queryStatusSilent())
    .then(() => this.getVolumeObject());
};

ArcamSa20Plugin.prototype.applyManualControls = function(data) {
  const source = this._normalizeSourceSelection(data.manualSource, conf.get('playSource') || 'CD');
  const volume = this._clampInt(data.manualVolume, 0, 99, this.cachedVolume);
  const balance = this._clampInt(data.manualBalance, -12, 12, 0);
  const steps = [];
  const sourceCode = SOURCE_CODES[source];

  if (typeof sourceCode === 'number') {
    steps.push(() => this._sendCommand(0x1D, [sourceCode]));
  }
  steps.push(() => this._sendCommand(0x0D, [volume]));
  steps.push(() => this._sendCommand(0x3B, [this._encodeBalance(balance)]));

  return this._runSeries(steps)
    .then(() => this.queryStatusSilent())
    .then(() => {
      this._toast('success', 'ARCAM SA20', 'Manual source / volume / balance applied');
    })
    .fail((err) => {
      this._toast('error', 'ARCAM SA20', 'Manual apply failed: ' + err.message);
      throw err;
    });
};

ArcamSa20Plugin.prototype.updateVolumeSettings = function() {
  return this.retrievevolume();
};

ArcamSa20Plugin.prototype.retrievevolume = function() {
  return this._queryVolume()
    .then(() => this._queryMute())
    .fail(() => libQ.resolve())
    .then(() => this.getVolumeObject());
};

ArcamSa20Plugin.prototype.volumioupdatevolume = function() {
  return this.getVolumeObject();
};

ArcamSa20Plugin.prototype.alsavolume = function(volumeRequest) {
  let promise;

  switch (volumeRequest) {
    case 'mute':
      this.cachedMute = true;
      promise = this._sendCommand(0x0E, [0x00]).then(() => this._queryMute());
      break;
    case 'unmute':
      this.cachedMute = false;
  this.idlePowerOffTimer = null;
      promise = this._sendCommand(0x0E, [0x01]).then(() => this._queryMute());
      break;
    case 'toggle':
      promise = this._sendCommand(0x0E, [0x02]).then(() => this._queryMute());
      break;
    case '+':
      this.cachedVolume = this._clampInt(this.cachedVolume + 1, 0, 99, this.cachedVolume);
      conf.set('lastVolume', this.cachedVolume);
      promise = this._sendCommand(0x0D, [0xF1]).then(() => {
        this._scheduleVolumeSync(300);
        return libQ.resolve();
      });
      break;
    case '-':
      this.cachedVolume = this._clampInt(this.cachedVolume - 1, 0, 99, this.cachedVolume);
      conf.set('lastVolume', this.cachedVolume);
      promise = this._sendCommand(0x0D, [0xF2]).then(() => {
        this._scheduleVolumeSync(300);
        return libQ.resolve();
      });
      break;
    default:
      const target = this._clampInt(volumeRequest, 0, 99, this.cachedVolume);
      this.cachedVolume = target;
      conf.set('lastVolume', this.cachedVolume);
      promise = this._sendCommand(0x0D, [target]).then(() => {
        this._scheduleVolumeSync(350);
        return libQ.resolve();
      });
      break;
  }

  return promise.then(() => this.getVolumeObject());
};


ArcamSa20Plugin.prototype._scheduleVolumeSync = function(delayMs) {
  const waitMs = this._clampInt(delayMs, 50, 2000, 350);
  if (this._volumeSyncTimer) {
    clearTimeout(this._volumeSyncTimer);
  }
  this._volumeSyncTimer = setTimeout(() => {
    this._volumeSyncTimer = null;
    this._queryVolume().fail(() => libQ.resolve());
  }, waitMs);
};

ArcamSa20Plugin.prototype.getVolumeObject = function() {
  return libQ.resolve({
    vol: this._clampInt(this.cachedVolume, 0, 99, 30),
    mute: !!this.cachedMute,
    currentDisableVolumeControl: false
  });
};

ArcamSa20Plugin.prototype._getAlsaConfigParam = function(key, fallbackValue) {
  try {
    const value = this.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller', 'getConfigParam', key);
    return typeof value === 'undefined' || value === null ? fallbackValue : value;
  } catch (e) {
    return fallbackValue;
  }
};

ArcamSa20Plugin.prototype._readNativeVolumeSettings = function() {
  const device = this._getAlsaConfigParam('outputdevice', '');
  if (!device) {
    return null;
  }

  return {
    device: device,
    devicename: this._getAlsaConfigParam('devicename', ''),
    mixer: this._getAlsaConfigParam('mixer', ''),
    mixertype: this._getAlsaConfigParam('mixertype', this._getAlsaConfigParam('mixer_type', 'hardware')),
    maxvolume: this._clampInt(this._getAlsaConfigParam('maxvolume', this._getAlsaConfigParam('max_volume', 100)), 1, 100, 100),
    volumecurve: this._getAlsaConfigParam('volumecurve', 'logarithmic'),
    volumesteps: this._clampInt(this._getAlsaConfigParam('volumesteps', 1), 1, 20, 1)
  };
};

ArcamSa20Plugin.prototype.initVolumeSettings = function() {
  const nativeSettings = this._readNativeVolumeSettings();
  if (!nativeSettings) {
    this.logger.warn('[arcam_sa20] skipping volume override because no ALSA outputdevice is configured');
    return libQ.resolve();
  }

  this.nativeVolumeSettings = nativeSettings;
  const volSettingsData = {
    pluginType: 'system_hardware',
    pluginName: 'arcam_sa20',
    volumeOverride: true,
    device: nativeSettings.device,
    devicename: 'ARCAM SA20',
    mixer: nativeSettings.mixer,
    mixertype: nativeSettings.mixertype,
    maxvolume: 99,
    volumecurve: nativeSettings.volumecurve,
    volumesteps: nativeSettings.volumesteps,
    currentmute: !!this.cachedMute,
    name: 'ARCAM SA20'
  };

  return this.commandRouter.volumioUpdateVolumeSettings(volSettingsData);
};

ArcamSa20Plugin.prototype.resetVolumeSettings = function() {
  const nativeSettings = this.nativeVolumeSettings || this._readNativeVolumeSettings();
  if (!nativeSettings) {
    return libQ.resolve();
  }

  const volSettingsData = Object.assign({}, nativeSettings, {
    volumeOverride: false,
    currentmute: false
  });

  return this.commandRouter.volumioUpdateVolumeSettings(volSettingsData)
    .fail(() => libQ.resolve());
};

ArcamSa20Plugin.prototype._activateSocketIO = function() {
  this.socket = io.connect('http://localhost:3000');
  this.socket.emit('getState');

  this.socket.on('pushState', (data) => {
    const current = data && data.status ? data.status : null;
    const previous = this.prevPlaybackStatus;

    this.currentPlaybackStatus = current;

    if ((previous === null || previous === 'stop' || previous === 'pause') && current === 'play') {
      this._cancelIdlePowerOffTimer();
      this._handlePlayTransition();
    } else {
      this._handlePlaybackStateForIdlePowerOff(current);
    }

    this.prevPlaybackStatus = current;
  });
};

ArcamSa20Plugin.prototype._cancelIdlePowerOffTimer = function() {
  if (this.idlePowerOffTimer) {
    clearTimeout(this.idlePowerOffTimer);
    this.idlePowerOffTimer = null;
  }
};

ArcamSa20Plugin.prototype._handlePlaybackStateForIdlePowerOff = function(status) {
  this.currentPlaybackStatus = status;
  if (status === 'play') {
    this._cancelIdlePowerOffTimer();
    return;
  }
  this._cancelAmpUnavailableStopTimer();
  if (status === 'pause' || status === 'stop' || status === null) {
    this._armIdlePowerOffTimer();
  }
};

ArcamSa20Plugin.prototype._armIdlePowerOffTimer = function() {
  this._cancelIdlePowerOffTimer();

  if (!conf.get('autoPowerOffOnIdle')) {
    return;
  }

  const delayMs = this._clampInt(conf.get('idlePowerOffDelaySec'), 1, 86400, 900) * 1000;

  this.idlePowerOffTimer = setTimeout(() => {
    this._maybePowerOffForIdle();
  }, delayMs);
};

ArcamSa20Plugin.prototype._maybePowerOffForIdle = function() {
  this.idlePowerOffTimer = null;

  if (!conf.get('autoPowerOffOnIdle')) {
    return;
  }

  if (this.currentPlaybackStatus === 'play') {
    return;
  }

  const targetSource = this._normalizeSourceSelection(conf.get('playSource'), 'CD');

  this._queryPower()
    .then((power) => {
      if (power !== 'On') {
        return libQ.reject(new Error('amplifier not on'));
      }
      return this._querySource();
    })
    .then((source) => {
      if (source !== targetSource) {
        return libQ.reject(new Error('source is not playback source'));
      }
      return this._sendCommand(0x00, [0x00])
        .then(() => this.queryStatusSilent());
    })
    .then(() => {
      this._log('idle auto-standby executed');
    })
    .fail((err) => {
      this._log('idle auto-standby skipped: ' + err.message);
    });
};

ArcamSa20Plugin.prototype._stopLiveStatusTimer = function() {
  if (this.liveStatusTimer) {
    clearInterval(this.liveStatusTimer);
    this.liveStatusTimer = null;
  }
  this.liveStatusBusy = false;
};

ArcamSa20Plugin.prototype._startLiveStatusTimer = function() {
  this._stopLiveStatusTimer();

  const tick = () => {
    if (this.liveStatusBusy) {
      return;
    }
    this.liveStatusBusy = true;
    this.queryStatusSilent()
      .fail(() => libQ.resolve())
      .fin(() => {
        this.liveStatusBusy = false;
      });
  };

  tick();
  this.liveStatusTimer = setInterval(tick, 5000);
};

ArcamSa20Plugin.prototype._handlePlayTransition = function() {
  if (this.playAutomationRunning) {
    return;
  }

  this.playAutomationRunning = true;

  this._preparePlaybackAutomation()
    .then(() => this.queryStatusSilent())
    .fail((err) => {
      this._toast('error', 'ARCAM SA20', 'Play automation failed: ' + err.message);
      this._log('play automation failed: ' + err.message);
    })
    .fin(() => {
      this.playAutomationRunning = false;
    });
};

ArcamSa20Plugin.prototype._preparePlaybackAutomation = function() {
  return this._ensurePoweredForPlayback()
    .then(() => {
      const steps = [];

      if (this.didAutoPowerOnForCurrentPlay && conf.get('switchSourceOnPlay')) {
        steps.push(() => this._setPlaybackSource());
      }

      if (this.didAutoPowerOnForCurrentPlay && conf.get('setVolumeOnPlay')) {
        steps.push(() => this._setPlaybackVolume());
      }

      return this._runSeries(steps);
    })
    .then((result) => {
      this.didAutoPowerOnForCurrentPlay = false;
  this.liveStatusTimer = null;
  this.liveStatusBusy = false;
      return result;
    })
    .fail((err) => {
      this.didAutoPowerOnForCurrentPlay = false;
  this.liveStatusTimer = null;
  this.liveStatusBusy = false;
      return libQ.reject(err);
    });
};

ArcamSa20Plugin.prototype._ensurePoweredForPlayback = function() {
  this.didAutoPowerOnForCurrentPlay = false;
  this.liveStatusTimer = null;
  this.liveStatusBusy = false;

  return this._queryPower()
    .then((power) => {
      if (power === 'On') {
        return libQ.resolve(false);
      }
      if (!conf.get('autoPowerOnPlay')) {
        return libQ.reject(new Error('amplifier is in standby and auto power on is disabled'));
      }
      this.didAutoPowerOnForCurrentPlay = true;
      return this._sendCommand(0x00, [0x01])
        .then(() => this._delay(this._clampInt(conf.get('powerOnDelayMs'), 0, 15000, 3500)))
        .then(() => true);
    })
    .fail((err) => {
      this.didAutoPowerOnForCurrentPlay = false;
  this.liveStatusTimer = null;
  this.liveStatusBusy = false;
      return libQ.reject(err);
    });
};

ArcamSa20Plugin.prototype._setPlaybackSource = function() {
  const source = this._normalizeSourceSelection(conf.get('playSource'), 'CD');
  const code = SOURCE_CODES[source];
  if (typeof code !== 'number') {
    return libQ.reject(new Error('invalid playback source'));
  }
  return this._sendCommand(0x1D, [code]);
};

ArcamSa20Plugin.prototype._setPlaybackVolume = function() {
  const volume = this._clampInt(conf.get('playVolume'), 0, 99, 30);
  return this._sendCommand(0x0D, [volume])
    .then(() => {
      this.cachedVolume = volume;
      conf.set('lastVolume', String(volume));
    });
};

ArcamSa20Plugin.prototype._cancelAmpUnavailableStopTimer = function() {
  if (this.ampUnavailableStopTimer) {
    clearTimeout(this.ampUnavailableStopTimer);
    this.ampUnavailableStopTimer = null;
  }
};

ArcamSa20Plugin.prototype._stopPlaybackForAmpUnavailable = function() {
  this.ampUnavailableStopTimer = null;

  if (this.currentPlaybackStatus !== 'play') {
    return libQ.resolve();
  }

  const stopViaSocket = () => {
    try {
      if (this.socket) {
        this.socket.emit('stop');
      }
    } catch (e) {
      // ignore
    }
    return libQ.resolve();
  };

  try {
    if (this.commandRouter && typeof this.commandRouter.volumioStop === 'function') {
      const maybe = this.commandRouter.volumioStop();
      return libQ.resolve(maybe).fail(() => stopViaSocket()).then(() => {
        this._log('playback stopped after amplifier was unavailable for 5 minutes');
      });
    }
  } catch (e) {
    return stopViaSocket().then(() => {
      this._log('playback stopped after amplifier was unavailable for 5 minutes');
    });
  }

  return stopViaSocket().then(() => {
    this._log('playback stopped after amplifier was unavailable for 5 minutes');
  });
};

ArcamSa20Plugin.prototype._armAmpUnavailableStopTimer = function() {
  if (this.currentPlaybackStatus !== 'play') {
    return;
  }
  if (this.ampUnavailableStopTimer) {
    return;
  }

  this.ampUnavailableStopTimer = setTimeout(() => {
    this._stopPlaybackForAmpUnavailable();
  }, 300000);

  this._log('amplifier unavailable/off while playing; stop timer armed for 300 seconds');
};

ArcamSa20Plugin.prototype._rebuildStatusSummaryFromCache = function() {
  const summary = [
    'PWR ' + (conf.get('lastPower') || '-'),
    'SRC ' + (conf.get('lastSource') || '-'),
    'VOL ' + (conf.get('lastVolume') !== undefined ? conf.get('lastVolume') : '-'),
    'MUTE ' + (conf.get('lastMute') || '-'),
    'BAL ' + (conf.get('lastBalance') || '-')
  ].join(' | ');
  conf.set('statusSummary', summary);
  return summary;
};

ArcamSa20Plugin.prototype._pushUiConfigRefresh = function() {
  return this.commandRouter.getUIConfigOnPlugin('system_hardware', 'arcam_sa20', {})
    .then((uiconf) => {
      this.commandRouter.broadcastMessage('pushUiConfig', uiconf);
      return uiconf;
    })
    .fail(() => libQ.resolve());
};

ArcamSa20Plugin.prototype._rebuildStatusSummaryFromCache = function() {
  const summary = [
    'PWR ' + (conf.get('lastPower') || '-'),
    'SRC ' + (conf.get('lastSource') || '-'),
    'VOL ' + (conf.get('lastVolume') !== undefined ? conf.get('lastVolume') : '-'),
    'MUTE ' + (conf.get('lastMute') || '-'),
    'BAL ' + (conf.get('lastBalance') || '-')
  ].join(' | ');
  conf.set('statusSummary', summary);
  return summary;
};

ArcamSa20Plugin.prototype._pushUiConfigRefresh = function() {
  return this.commandRouter.getUIConfigOnPlugin('system_hardware', 'arcam_sa20', {})
    .then((uiconf) => {
      this.commandRouter.broadcastMessage('pushUiConfig', uiconf);
      return uiconf;
    })
    .fail(() => libQ.resolve());
};

ArcamSa20Plugin.prototype._publishVolumeToVolumioIfChanged = function() {
  return this.getVolumeObject().then((volumeObject) => {
    const vol = volumeObject && typeof volumeObject.vol !== 'undefined' ? volumeObject.vol : null;
    const mute = volumeObject ? !!volumeObject.mute : false;

    const changed = (vol !== this.lastPublishedVolume) || (mute !== this.lastPublishedMute);
    if (!changed) {
      return volumeObject;
    }

    this.lastPublishedVolume = vol;
    this.lastPublishedMute = mute;

    return this.commandRouter.volumioupdatevolume(volumeObject)
      .fail(() => libQ.resolve())
      .then(() => volumeObject);
  });
};

ArcamSa20Plugin.prototype._pollStatusAndReflect = function() {
  if (this.liveStatusBusy) {
    return libQ.resolve();
  }

  this.liveStatusBusy = true;

  return this._queryAndCacheStatus()
    .then(() => {
      if (conf.get('lastPower') === 'On') {
        this._cancelAmpUnavailableStopTimer();
      } else {
        this._armAmpUnavailableStopTimer();
      }
    })
    .then(() => this._rebuildStatusSummaryFromCache())
    .then(() => this._publishVolumeToVolumioIfChanged())
    .then(() => this._pushUiConfigRefresh())
    .fail((err) => {
      this._armAmpUnavailableStopTimer();
      this._log('status poll failed: ' + err.message);
      return libQ.resolve();
    })
    .fin(() => {
      this.liveStatusBusy = false;
    });
};

ArcamSa20Plugin.prototype._stopLiveStatusTimer = function() {
  if (this.liveStatusTimer) {
    clearInterval(this.liveStatusTimer);
    this.liveStatusTimer = null;
  }
  this.liveStatusBusy = false;
};

ArcamSa20Plugin.prototype._startLiveStatusTimer = function() {
  this._stopLiveStatusTimer();
  this._pollStatusAndReflect();
  this.liveStatusTimer = setInterval(() => {
    this._pollStatusAndReflect();
  }, 5000);
};


ArcamSa20Plugin.prototype._queryAndCacheStatus = function() {
  return this._runSeries([
    () => this._queryPower(),
    () => this._queryVolume(),
    () => this._queryMute(),
    () => this._querySource(),
    () => this._queryBalance()
  ]).then(() => {
    const now = new Date();
    const ts = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0');
    conf.set('lastStatusUpdate', ts);
    this._rebuildStatusSummaryFromCache();
  });
};

ArcamSa20Plugin.prototype._queryPower = function() {
  return this._sendCommand(0x00, [0xF0]).then((resp) => {
    const parsed = this._parsePower(resp);
    conf.set('lastPower', parsed);
    return parsed;
  });
};

ArcamSa20Plugin.prototype._queryVolume = function() {
  return this._sendCommand(0x0D, [0xF0]).then((resp) => {
    const parsed = this._parseVolume(resp);
    conf.set('lastVolume', parsed);
    this.cachedVolume = this._clampInt(parsed, 0, 99, this.cachedVolume);
    return parsed;
  });
};

ArcamSa20Plugin.prototype._queryMute = function() {
  return this._sendCommand(0x0E, [0xF0]).then((resp) => {
    const parsed = this._parseMute(resp);
    conf.set('lastMute', parsed);
    this.cachedMute = parsed === 'Muted';
    return parsed;
  });
};

ArcamSa20Plugin.prototype._querySource = function() {
  return this._sendCommand(0x1D, [0xF0]).then((resp) => {
    const parsed = this._parseSource(resp);
    conf.set('lastSource', parsed);
    return parsed;
  });
};

ArcamSa20Plugin.prototype._queryBalance = function() {
  return this._sendCommand(0x3B, [0xF0]).then((resp) => {
    const parsed = this._parseBalance(resp);
    conf.set('lastBalance', parsed);
    return parsed;
  });
};

ArcamSa20Plugin.prototype._connectOnly = function() {
  const defer = libQ.defer();
  const socket = net.createConnection({ host: conf.get('host'), port: this._clampInt(conf.get('port'), 1, 65535, 50000) });
  const timeoutMs = this._clampInt(conf.get('timeoutMs'), 500, 20000, 3000);
  let settled = false;

  socket.setTimeout(timeoutMs);

  socket.on('connect', () => {
    if (!settled) {
      settled = true;
      socket.end();
      defer.resolve();
    }
  });

  socket.on('timeout', () => {
    if (!settled) {
      settled = true;
      socket.destroy();
      defer.reject(new Error('timeout'));
    }
  });

  socket.on('error', (err) => {
    if (!settled) {
      settled = true;
      defer.reject(err);
    }
  });

  return defer.promise;
};

ArcamSa20Plugin.prototype._sendCommand = function(command, dataBytes) {
  const defer = libQ.defer();
  const socket = net.createConnection({
    host: conf.get('host'),
    port: this._clampInt(conf.get('port'), 1, 65535, 50000)
  });
  const timeoutMs = this._clampInt(conf.get('timeoutMs'), 500, 20000, 3000);
  const payload = Buffer.from([0x21, 0x01, command, dataBytes.length].concat(dataBytes).concat([0x0D]));
  const chunks = [];
  let settled = false;

  socket.setTimeout(timeoutMs);

  socket.on('connect', () => socket.write(payload));

  socket.on('data', (chunk) => {
    chunks.push(chunk);
    if (chunk.includes(0x0D) && !settled) {
      settled = true;
      socket.end();
      try {
        defer.resolve(this._parseResponse(Buffer.concat(chunks)));
      } catch (e) {
        defer.reject(e);
      }
    }
  });

  socket.on('timeout', () => {
    if (!settled) {
      settled = true;
      socket.destroy();
      defer.reject(new Error('timeout'));
    }
  });

  socket.on('error', (err) => {
    if (!settled) {
      settled = true;
      defer.reject(err);
    }
  });

  socket.on('end', () => {
    if (!settled && chunks.length > 0) {
      settled = true;
      try {
        defer.resolve(this._parseResponse(Buffer.concat(chunks)));
      } catch (e) {
        defer.reject(e);
      }
    }
  });

  return defer.promise.then((resp) => {
    if (resp.answerCode !== 0x00) {
      throw new Error('amplifier returned answer code 0x' + ('0' + resp.answerCode.toString(16)).slice(-2));
    }
    return resp;
  });
};

ArcamSa20Plugin.prototype._parseResponse = function(buffer) {
  if (!buffer || buffer.length < 6) {
    throw new Error('incomplete response');
  }
  if (buffer[0] !== 0x21) {
    throw new Error('invalid start byte');
  }
  if (buffer[buffer.length - 1] !== 0x0D) {
    throw new Error('invalid end byte');
  }

  return {
    zone: buffer[1],
    command: buffer[2],
    answerCode: buffer[3],
    declaredLength: buffer[4],
    data: Array.from(buffer.slice(5, -1)),
    rawHex: Array.from(buffer).map((b) => ('0' + b.toString(16)).slice(-2).toUpperCase()).join(' ')
  };
};

ArcamSa20Plugin.prototype._parsePower = function(resp) {
  if (!resp.data.length) return 'Unknown';
  return resp.data[0] === 0x01 ? 'On' : 'Standby';
};

ArcamSa20Plugin.prototype._parseVolume = function(resp) {
  if (!resp.data.length) return 'Unknown';
  return String(resp.data[0]);
};

ArcamSa20Plugin.prototype._parseMute = function(resp) {
  if (!resp.data.length) return 'Unknown';
  if (resp.data[0] === 0x00) return 'Muted';
  if (resp.data[0] === 0x01) return 'Unmuted';
  return 'Unknown';
};

ArcamSa20Plugin.prototype._parseSource = function(resp) {
  if (!resp.data.length) return 'Unknown';
  const sourceCode = resp.data[0] & 0x0F;
  return SOURCE_NAMES[sourceCode] || 'Unknown';
};

ArcamSa20Plugin.prototype._parseBalance = function(resp) {
  if (!resp.data.length) return 'Unknown';
  const value = resp.data[0];
  if (value === 0x00) return '0';
  if (value >= 0x01 && value <= 0x0C) return '+' + String(value);
  if (value >= 0x81 && value <= 0x8C) return '-' + String(value - 0x80);
  return 'Unknown';
};

ArcamSa20Plugin.prototype._encodeBalance = function(value) {
  if (value === 0) return 0x00;
  if (value > 0) return value;
  return 0x80 + Math.abs(value);
};

ArcamSa20Plugin.prototype._balanceStringToInt = function(value) {
  if (typeof value !== 'string') return 0;
  if (value === '0') return 0;
  if (value.startsWith('+')) return this._clampInt(value.substring(1), 0, 12, 0);
  if (value.startsWith('-')) return -this._clampInt(value.substring(1), 0, 12, 0);
  return 0;
};

ArcamSa20Plugin.prototype._normalizeSourceSelection = function(value, fallback) {
  if (value && typeof value === 'object' && value.value) {
    value = value.value;
  }
  if (value && typeof value === 'object' && value.label) {
    value = value.label;
  }
  const candidate = String(value || fallback || 'CD');
  return Object.prototype.hasOwnProperty.call(SOURCE_CODES, candidate) ? candidate : fallback;
};

ArcamSa20Plugin.prototype._setUIValue = function(uiconf, id, value) {
  if (!uiconf || !uiconf.sections) return;
  uiconf.sections.forEach((section) => {
    if (!section.content) return;
    section.content.forEach((item) => {
      if (item.id !== id) return;
      if (item.element === 'select') {
        item.value = { value: value, label: value };
      } else {
        item.value = value;
      }
    });
  });
};

ArcamSa20Plugin.prototype._runSeries = function(tasks) {
  return tasks.reduce((promise, task) => promise.then(() => task()), libQ.resolve());
};

ArcamSa20Plugin.prototype._delay = function(ms) {
  const defer = libQ.defer();
  setTimeout(() => defer.resolve(), ms);
  return defer.promise;
};

ArcamSa20Plugin.prototype._clampInt = function(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

ArcamSa20Plugin.prototype._toast = function(type, title, message) {
  try {
    this.commandRouter.pushToastMessage(type, title, message);
  } catch (e) {
    this._log(title + ': ' + message);
  }
};

ArcamSa20Plugin.prototype._log = function(message) {
  if (conf.get('debugLogging')) {
    this.logger.info('[arcam_sa20] ' + message);
  }
};
