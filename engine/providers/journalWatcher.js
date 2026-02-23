// engine/journalWatcher.js
const fs = require('fs')
const path = require('path')
const chokidar = require('chokidar')
const { EventEmitter } = require('events')

class JournalWatcher extends EventEmitter {
  constructor(journalDir) {
    super()
    this.journalDir = journalDir
    this.currentFile = null
    this.filePosition = 0
    this.watcher = null
    this.statusWatcher = null
    this.navRouteWatcher = null
    this._fileWatcher = null
    this.state = {
      systemName: null,
      starPos: null,
      allegiance: null,
      security: null,
      economy: null,
      secondEconomy: null,
      government: null,
      population: null,
      factions: [],
      powers: [],
      powerplayState: null,
      jumpDist: null,
      fuelUsed: null,
      fuelLevel: null,
      bodiesScanned: [],
      totalBodies: null,
      nonBodyCount: null,
      navRoute: [],
      docked: false,
      supercruise: false,
      landed: false,
      jumping: false,
      jumpTarget: null,
      stationName: null,
      stationType: null,
      inSRV: false,
      onFoot: false,
      fuelScooping: false,
      fsdCharging: false,
      fsdCooldown: false,
      fsdMassLocked: false,
      shieldsUp: false,
      hardpointsDeployed: false,
      inWing: false,
      cargoScoopDeployed: false,
      pips: null,
      firegroup: null,
      guiFocus: null,
      fuel: null,
      cargo: null,
      legalState: null,
      heading: null,
      altitude: null,
      latitude: null,
      longitude: null,
      bodyName: null,
      planetRadius: null,
      balance: null,
    }
  }

  start() {
    this._loadLatestJournal()

    // Watch for new journal files (new game session)
    this.watcher = chokidar.watch(
      path.join(this.journalDir, 'Journal.*.log'),
      { ignoreInitial: false, usePolling: false }
    )
    this.watcher.on('add', (filePath) => {
      if (!this.currentFile || filePath > this.currentFile) {
        this._switchToFile(filePath, false)
      }
    })

    // Watch Status.json
    const statusPath = path.join(this.journalDir, 'Status.json')
    this.statusWatcher = chokidar.watch(statusPath, { usePolling: false, awaitWriteFinish: false })
    this.statusWatcher.on('change', () => this._readStatus(statusPath))
    this._readStatus(statusPath)

    // Watch NavRoute.json
    const navRoutePath = path.join(this.journalDir, 'NavRoute.json')
    this.navRouteWatcher = chokidar.watch(navRoutePath, { usePolling: false })
    this.navRouteWatcher.on('change', () => this._readNavRoute(navRoutePath))
    this._readNavRoute(navRoutePath)
  }

  stop() {
    if (this.watcher) this.watcher.close()
    if (this.statusWatcher) this.statusWatcher.close()
    if (this.navRouteWatcher) this.navRouteWatcher.close()
    if (this._fileWatcher) this._fileWatcher.close()
  }

  _loadLatestJournal() {
    try {
      const files = fs.readdirSync(this.journalDir)
        .filter(f => /^Journal\.\d{4}-\d{2}-\d{2}T\d{6}\.\d+\.log$/.test(f))
        .map(f => path.join(this.journalDir, f))
        .sort()

      if (files.length > 0) {
        const latest = files[files.length - 1]
        this._switchToFile(latest, true)
      }
    } catch (err) {
      console.error('JournalWatcher: could not read journal dir', err)
    }
  }

  _switchToFile(filePath, readHistory = false) {
    this.currentFile = filePath
    this.filePosition = 0

    if (readHistory) {
      this._readFileFrom(filePath, 0)
    } else {
      try {
        const stat = fs.statSync(filePath)
        this.filePosition = stat.size
      } catch {}
    }

    if (this._fileWatcher) this._fileWatcher.close()
    this._fileWatcher = chokidar.watch(filePath, { usePolling: false })
    this._fileWatcher.on('change', () => this._readFileFrom(filePath, this.filePosition))
  }

  _readFileFrom(filePath, fromByte) {
    try {
      const stat = fs.statSync(filePath)
      if (stat.size <= fromByte) return

      const fd = fs.openSync(filePath, 'r')
      const buffer = Buffer.alloc(stat.size - fromByte)
      fs.readSync(fd, buffer, 0, buffer.length, fromByte)
      fs.closeSync(fd)

      this.filePosition = stat.size

      const newText = buffer.toString('utf8')
      const lines = newText.split('\n').filter(l => l.trim())

      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          this._handleEvent(event)
        } catch {}
      }
    } catch (err) {
      console.error('JournalWatcher: read error', err)
    }
  }

  _handleEvent(event) {
    switch (event.event) {

      case 'Location':
      case 'FSDJump':
      case 'CarrierJump': {
        const prevSystem = this.state.systemName
        this.state.systemName = event.StarSystem || event.SystemName || null
        this.state.starPos = event.StarPos || null
        this.state.allegiance = event.SystemAllegiance || null
        this.state.economy = event.SystemEconomy_Localised || event.SystemEconomy || null
        this.state.secondEconomy = event.SystemSecondEconomy_Localised || null
        this.state.government = event.SystemGovernment_Localised || event.SystemGovernment || null
        this.state.security = event.SystemSecurity_Localised || event.SystemSecurity || null
        this.state.population = event.Population || null
        this.state.factions = event.Factions || []
        this.state.powers = event.Powers || []
        this.state.powerplayState = event.PowerplayState || null
        this.state.jumpDist = event.JumpDist || null
        this.state.fuelUsed = event.FuelUsed || null
        this.state.fuelLevel = event.FuelLevel || null
        this.state.jumping = false
        this.state.jumpTarget = null

        if (prevSystem !== this.state.systemName) {
          this.state.bodiesScanned = []
          this.state.totalBodies = null
          this.state.nonBodyCount = null
        }

        this.emit('systemChanged', this._getState())
        this.emit('stateChanged', this._getState())
        break
      }

      case 'FSSDiscoveryScan': {
        this.state.totalBodies = event.BodyCount || null
        this.state.nonBodyCount = event.NonBodyCount || null
        this.emit('honk', this._getState())
        this.emit('stateChanged', this._getState())
        break
      }

      case 'Scan': {
        const body = {
          name: event.BodyName,
          type: event.StarType ? 'Star' : (event.PlanetClass ? 'Planet' : 'Belt'),
          starType: event.StarType || null,
          subClass: event.Subclass !== undefined ? event.Subclass : null,
          luminosity: event.Luminosity || null,
          planetClass: event.PlanetClass || null,
          terraformState: event.TerraformState || null,
          atmosphereType: event.AtmosphereType || null,
          atmosphereComposition: event.AtmosphereComposition || [],
          landable: event.Landable || false,
          massEM: event.MassEM || null,
          radius: event.Radius || null,
          surfaceGravity: event.SurfaceGravity || null,
          surfacePressure: event.SurfacePressure || null,
          surfaceTemp: event.SurfaceTemperature || null,
          volcanism: event.Volcanism || null,
          tidalLock: event.TidalLock || null,
          distFromArrivalLs: event.DistanceFromArrivalLS || null,
          rings: event.Rings || [],
          bodyId: event.BodyID || null,
          parents: event.Parents || [],
          wasDiscovered: event.WasDiscovered || false,
          wasMapped: event.WasMapped || false,
          scanType: event.ScanType || null,
          orbitalPeriod: event.OrbitalPeriod || null,
          semiMajorAxis: event.SemiMajorAxis || null,
          eccentricity: event.Eccentricity || null,
          orbitalInclination: event.OrbitalInclination || null,
          rotationPeriod: event.RotationPeriod || null,
          axialTilt: event.AxialTilt || null,
          absoluteMagnitude: event.AbsoluteMagnitude || null,
          stellarMass: event.StellarMass || null,
          age_MY: event.Age_MY || null,
          signals: null,
        }

        const idx = this.state.bodiesScanned.findIndex(b => b.name === body.name)
        if (idx >= 0) {
          this.state.bodiesScanned[idx] = { ...this.state.bodiesScanned[idx], ...body }
        } else {
          this.state.bodiesScanned.push(body)
        }

        this.emit('bodyScan', { body, state: this._getState() })
        this.emit('stateChanged', this._getState())
        break
      }

      case 'FSSBodySignals': {
        const bodyName = event.BodyName
        const signals = event.Signals || []
        const body = this.state.bodiesScanned.find(b => b.name === bodyName)
        if (body) {
          body.signals = signals
          this.emit('stateChanged', this._getState())
        }
        break
      }

      case 'SAAScanComplete': {
        const body = this.state.bodiesScanned.find(b => b.name === event.BodyName)
        if (body) {
          body.mapped = true
          body.efficientMap = event.ProbesUsed <= event.EfficiencyTarget
          this.emit('stateChanged', this._getState())
        }
        break
      }

      case 'Docked': {
        this.state.docked = true
        this.state.stationName = event.StationName || null
        this.state.stationType = event.StationType || null
        this.emit('docked', this._getState())
        this.emit('stateChanged', this._getState())
        break
      }

      case 'Undocked': {
        this.state.docked = false
        this.state.stationName = null
        this.state.stationType = null
        this.emit('undocked', this._getState())
        this.emit('stateChanged', this._getState())
        break
      }

      case 'Touchdown': {
        this.state.landed = true
        this.emit('stateChanged', this._getState())
        break
      }

      case 'Liftoff': {
        this.state.landed = false
        this.emit('stateChanged', this._getState())
        break
      }

      case 'StartJump': {
        if (event.JumpType === 'Hyperspace') {
          this.state.jumping = true
          this.state.jumpTarget = event.StarSystem || null
          this.emit('jumpStarted', this._getState())
          this.emit('stateChanged', this._getState())
        }
        break
      }

      case 'SupercruiseEntry': {
        this.state.supercruise = true
        this.emit('stateChanged', this._getState())
        break
      }

      case 'SupercruiseExit': {
        this.state.supercruise = false
        this.emit('stateChanged', this._getState())
        break
      }
    }
  }

  _readStatus(statusPath) {
    try {
      const raw = fs.readFileSync(statusPath, 'utf8')
      const status = JSON.parse(raw)
      const flags = status.Flags || 0

      this.state.docked             = !!(flags & (1 << 0))
      this.state.landed             = !!(flags & (1 << 1))
      this.state.landingGearDown    = !!(flags & (1 << 2))
      this.state.shieldsUp          = !!(flags & (1 << 3))
      this.state.supercruise        = !!(flags & (1 << 4))
      this.state.flightAssistOff    = !!(flags & (1 << 5))
      this.state.hardpointsDeployed = !!(flags & (1 << 6))
      this.state.inWing             = !!(flags & (1 << 7))
      this.state.cargoScoopDeployed = !!(flags & (1 << 9))
      this.state.fsdMassLocked      = !!(flags & (1 << 16))
      this.state.fsdCharging        = !!(flags & (1 << 17))
      this.state.fsdCooldown        = !!(flags & (1 << 18))
      this.state.fuelScooping       = !!(flags & (1 << 20))
      this.state.inSRV              = !!(flags & (1 << 26))
      this.state.onFoot             = !!(flags & (1 << 27))

      this.state.pips        = status.Pips || null
      this.state.firegroup   = status.Firegroup
      this.state.guiFocus    = status.GuiFocus
      this.state.fuel        = status.Fuel || null
      this.state.cargo       = status.Cargo
      this.state.legalState  = status.LegalState
      this.state.heading     = status.Heading
      this.state.altitude    = status.Altitude
      this.state.latitude    = status.Latitude
      this.state.longitude   = status.Longitude
      this.state.bodyName    = status.BodyName
      this.state.planetRadius = status.PlanetRadius
      this.state.balance     = status.Balance

      this.emit('statusChanged', this._getState())
    } catch {
      // Status.json may be temporarily unavailable during writes
    }
  }

  _readNavRoute(navRoutePath) {
    try {
      const raw = fs.readFileSync(navRoutePath, 'utf8')
      const data = JSON.parse(raw)
      this.state.navRoute = data.Route || []
      this.emit('navRouteChanged', this._getState())
      this.emit('stateChanged', this._getState())
    } catch {
      this.state.navRoute = []
    }
  }

  _getState() {
    return { ...this.state, bodiesScanned: [...this.state.bodiesScanned] }
  }
}

module.exports = JournalWatcher
