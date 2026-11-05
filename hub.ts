/*
 * Calliope mini Hub - a hub that collects readings from several minis and serves them
 * as a dashboard: live table, per-sensor charts, CSV download and the
 * switch/slider controls. Every reading is also written to the flash log
 * (datalogger); the table, charts and CSV are read back from it.
 *
 * Transport rules that keep the hub alive with several nodes plus a browser:
 * requests are rescued out of AT replies, rxBuf is bounded, the buffer is
 * drained before parsing, node pushes get no reply, and the page is sent in
 * CHUNK-sized pieces rather than built as one string (one big string caused
 * GC_TOO_BIG_ALLOCATION, error 022). /live returns just the latest values as
 * plain text, for a minimal client.
 *
 * HUB PROGRAM (one board)
 *   wifiHub.startHub("CalliopeHub", "")
 *   // then open http://10.0.0.1 on a phone joined to that network
 *
 * Columns are not declared: each reading's name becomes a column the first
 * time it arrives. The hub tracks the current header itself (logCols),
 * because the flash log only appends a new header line when a column is
 * added later.
 *
 * NODE PROGRAM (each other board)
 *   wifiHub.joinHub("CalliopeHub", "")   // shows up as its device name
 *   basic.forever(function () {
 *       wifiHub.sendValues(
 *           datalogger.createCV("temp", input.temperature()),
 *           datalogger.createCV("licht", input.lightLevel()))
 *       basic.pause(2000)
 *   })
 *
 * A board is either a hub or a node, never both: the hub needs CWMODE=2
 * (SoftAP) and a node needs CWMODE=1 (station).
 */

// Which dashboard control (switch / slider A, B or C) a block refers to.
enum LiveControl {
    //% block="A"
    A = 0,
    //% block="B"
    B = 1,
    //% block="C"
    C = 2
}

//% weight=9 color=#6476fd icon="" block="Hub"
//% groups='["Hub", "Controls", "Node", "Status"]'
namespace wifiHub {

    // The access point's fixed address. One definition: AT+CIPAP pins it and
    // liveAddress() reports it, so the two cannot drift apart.
    const AP_IP = "10.0.0.1"

    // mDNS name the hub announces, so the page is also at
    // http://calliopehub.local. This works on iOS, macOS, Windows 10+ and Linux
    // (avahi), and only partly on Android, so 10.0.0.1 stays the address we
    // show. With several hubs in one room each is on its own network, so the
    // same name does not clash.
    const MDNS_NAME = "calliopehub"

    // SoftAP channel: one of the non-overlapping 2.4 GHz channels 1/6/11, picked
    // from the mini's serial number, so several hubs in one room spread out.
    function apChannel(): number {
        const sn = control.deviceSerialNumber()
        return [1, 6, 11][((sn % 3) + 3) % 3]   // serial may be negative
    }

    // How many different minis can be shown. Each costs one name plus one
    // readings string; a small cap keeps the page bounded and the heap calm.
    const MAX_NODES = 8

    // Close idle sockets after this long with no request, so a browser that
    // vanished cannot hold one of the five slots for ever.
    const IDLE_RECOVER_MS = 20000

    // The UART pins to the WiFi module, shared by hub and node. Set by
    // "start hub" / "join hub" (default: the Grove connector, C17/C16) and
    // reused by every later redirect (link speed, rejoin).
    let txPin = SerialPin.C17
    let rxPin = SerialPin.C16
    // Set once the built-in serial has left the USB pins. Debug lines are held
    // back until then: a handler that writes to USB through a second UART
    // (extra-serial) must not open it while the built-in serial still drives
    // USB_TX.
    let serialOffUsb = false
    // Network name and password, from "start hub" or "join hub". A node
    // keeps them so it can rejoin by itself.
    let ssid = ""
    let passwd = ""

    let rxBuf = ""
    let running = false
    let loopAlive = false
    let apReady = false
    let lastRequestTime = 0

    // The whole "database": one slot per node, holding its most recent readings
    // exactly as they arrived ("temp=21.4&licht=88"). Overwritten on each push,
    // so memory does not grow no matter how long the hub runs.
    let nodeNames: string[] = []
    let nodeData: string[] = []
    let nodeSeen: number[] = []          // runningTime() of the last push
    let pushCount = 0

    // UART speed to the module, once it is up. 0 = leave it at 115200.
    //
    // At 115200 the 13 KB page is ~1.17 s of pure wire time, which is now the
    // floor on page load. Doubling the rate halves it.
    let fastBaud = 0

    // Radio transmit power, in units of 0.25 dBm (AT+RFPOWER). 0 = leave the
    // module's default (80 = 20 dBm) alone.
    //
    // The Calliope's edge connector supplies roughly 200 mA, but an ESP32-C3
    // transmitting at the default 20 dBm draws ~335 mA. Lowering this keeps the
    // peak inside the budget at the cost of range. See setTxPower.
    let txPowerQuarterDbm = 0

    // ---- dashboard state (charts / history / CSV) ----
    // Bytes per AT+CIPSEND packet. AT+CIPSEND accepts up to 8192 (past that the
    // docs require AT+CIPSENDL), and every packet costs two AT round trips, so
    // fewer and larger is strictly faster. 2048 halves the packet count while
    // staying well clear of the limit.
    const CHUNK = 2048               // max bytes per AT+CIPSEND packet
    const SEED_ROWS = 50             // rows sent on a client's first poll
    const MAX_ROWS_PER_POLL = 50     // cap so a late client catches up gradually
    let pageSegs: string[] = []
    let logFull = false              // set by datalogger.onLogFull -> page banner
    let lastRowCount = 0             // client's new cursor -> X-Row-Count
    let lastTotalRows = 0            // device total -> X-Total-Rows
    let bootRow = 0                  // first log row of this start -> X-Boot-Row
    let ctrlToggle = [false, false, false]
    let ctrlSlider = [0, 0, 0]
    // Wall-clock sync: the browser piggybacks its Unix time on every /data poll.
    let syncedEpochSec = 0
    let syncedDeviceMs = 0
    let timeSynced = false

    // ---- node side ----
    let joined = false
    let hubHost = AP_IP
    let pushStage = 0
    // The hub mini's own row name, for logHubValues. Empty means the
    // default, "<device name> (hub)". See setHubName.
    let hubName = ""
    // Set by joinHub to this mini's device name; every sendValues push
    // carries it.
    let myNodeName = ""
    let lastRejoin = 0

    // ---- setup animations ----
    // Shown only when the user's program starts the hub or joins: the
    // automatic recoveries (rejoin, hub re-setup after a module reboot) run
    // in the background and must not overwrite whatever the program shows.
    let setupAnim = true
    // True while an animation fiber is still playing its frames.
    let animRunning = false
    // Set by endSetupAnim: the fiber stops after the cycle it is playing.
    let animStop = false

    // Loop the animation in the background while setup carries on, until
    // endSetupAnim stops it. A cycle always plays to the end, so the
    // animation never cuts off halfway. kind 0 = hub (growing broadcast
    // signal), 1 = node (WiFi bars filling up). Each showLeds holds its frame
    // for the default 400 ms.
    function startSetupAnim(kind: number) {
        if (!setupAnim) return
        animRunning = true
        animStop = false
        control.inBackground(function () {
            while (!animStop) {
                if (kind == 0) {
                    basic.showLeds(`
                        . . . . .
                        . . . . .
                        . . . . .
                        . . . . .
                        # . . . .
                        `)
                    basic.showLeds(`
                        . . . . .
                        . . . . .
                        # # . . .
                        . . # . .
                        # . # . .
                        `)
                    basic.showLeds(`
                        # # # . .
                        . . . # .
                        # # . . #
                        . . # . #
                        # . # . #
                        `)
                } else {
                    basic.showLeds(`
                        . . . . .
                        . . . . .
                        . . . . .
                        . . . . .
                        . . # . .
                        `)
                    basic.showLeds(`
                        . . . . .
                        . . . . .
                        . # # # .
                        . . . . .
                        . . # . .
                        `)
                    basic.showLeds(`
                        # # # # #
                        . . . . .
                        . # # # .
                        . . . . .
                        . . # . .
                        `)
                }
            }
            animRunning = false
        })
    }

    // Stop the loop, wait for its current cycle to finish, then show a
    // checkmark if setup succeeded or an X if it failed.
    function endSetupAnim(ok: boolean) {
        if (!setupAnim) return
        animStop = true
        while (animRunning) basic.pause(20)
        if (ok) basic.showLeds(`
            . . . . .
            . . . . #
            . . . # .
            # . # . .
            . # . . .
            `)
        else basic.showLeds(`
            # . . . #
            . # . # .
            . . # . .
            . # . # .
            # . . . #
            `)
    }

    let pendingCmd = ""
    // Text of the most recent AT reply, so callers can inspect it without
    // re-reading the port (which would consume the next request).
    let lastReply = ""
    // Set by sendChunk when the module reported the peer closing during the
    // send, so the caller can skip a CIPCLOSE that would only answer ERROR.
    let peerClosed = false

    // ==================================================================
    // Hub
    // ==================================================================

    /**
     * Start the hub: make the WiFi network the other minis join, log what
     * they send, and serve the dashboard. The columns follow the readings
     * the minis send; each new name becomes a column.
     */
    //% block="start hub|network name %name|password %pass||TX %tx|RX %rx"
    //% blockId=wifilivestarthub
    //% tx.defl=SerialPin.C17
    //% rx.defl=SerialPin.C16
    //% name.defl="CalliopeHub"
    //% expandableArgumentMode="toggle"
    //% group="Hub"
    //% weight=100
    export function startHub(name: string, pass: string, tx?: SerialPin, rx?: SerialPin) {
        setPins(tx, rx)
        ssid = name
        passwd = pass
        nodeNames = []
        nodeData = []
        nodeSeen = []
        pushCount = 0

        // No setColumnTitles: record() always logs "node" first, so a fresh
        // log starts with it, and every other column is added as it first
        // arrives. loadLogCols() picks up the header of an existing log.
        loadLogCols()
        // Rows before this index come from an earlier start: their
        // "Time (seconds)" counts from a different boot, so the page shows no
        // clock time for them.
        bootRow = logRowCount()

        // The page shows a banner when the flash log fills up.
        datalogger.onLogFull(function () { logFull = true })

        apSetup()
        startBackgroundServer()
    }

    /**
     * Speed up the link to the WiFi module (default 115200).
     *
     * The dashboard page is ~13 KB, and at 115200 baud that is ~1.2 s of pure
     * transmission -- the floor on how fast a page can load. 230400 halves it.
     *
     * SAFE TO TRY: the module is switched with AT+UART_CUR, which is NOT saved
     * to its flash, so unplugging the module always restores 115200. If the new
     * rate does not work, this block detects it and falls back by itself.
     *
     * Call it BEFORE "start hub" or "join hub".
     */
    //% block="WiFi link speed %baud"
    //% baud.defl=230400
    //% group="Hub"
    //% weight=84
    //% advanced=true
    export function setLinkSpeed(baud: number) {
        fastBaud = baud
    }

    // Switch both ends to fastBaud, verifying that the module still answers.
    // Called once the module is awake and answering at 115200.
    //
    // Order matters: tell the module first, then follow it. Between those two
    // steps the two ends disagree, so nothing may be sent in between.
    function applyLinkSpeed() {
        if (fastBaud <= 0 || fastBaud == 115200) return

        sendAtCmd("AT+UART_CUR=" + fastBaud + ",8,1,0,0")
        // The OK comes back at the OLD rate, but the module switches as it
        // sends -- so do not wait for it, just give it time to change.
        basic.pause(200)

        // Follow. pxt's BaudRate enum stops at 115200, so the value is cast
        // through; CODAL's setBaud() takes it as a plain number.
        serial.redirect(txPin, rxPin, fastBaud as BaudRate)
        serial.setRxBufferSize(254)
        basic.pause(100)
        serial.readString()                  // drop any garbage from the switch

        // Verify. If the module is not intelligible at the new rate, go back --
        // otherwise the whole driver is mute until someone unplugs the module.
        let ok = false
        for (let i = 0; i < 5 && !ok; i++) {
            sendAtCmd("AT")
            if (waitAt("OK", "ERROR", "None", 300) == 1) ok = true
            else basic.pause(100)
        }
        if (ok) {
            note("link speed now " + fastBaud)
            return
        }

        note("link speed " + fastBaud + " failed -- back to 115200")
        serial.redirect(txPin, rxPin, BaudRate.BaudRate115200)
        serial.setRxBufferSize(254)
        basic.pause(100)
        serial.readString()
        // The module may or may not have switched; AT+UART_CUR is volatile, so
        // if it did and we cannot reach it, only a power cycle helps. Say so.
        for (let i = 0; i < 5; i++) {
            sendAtCmd("AT")
            if (waitAt("OK", "ERROR", "None", 300) == 1) return
            basic.pause(100)
        }
        note("module unreachable -- power-cycle it")
    }

    /**
     * Reduce the WiFi transmit power, in dBm. Range 10 to 20; the module's
     * default is 20.
     *
     * Use this if the module resets, hangs on a cold start, or drops its
     * connection under load. The Calliope's connector supplies about 200 mA,
     * while transmitting at 20 dBm draws roughly 335 mA -- the shortfall shows
     * up as a brown-out at exactly the moments the radio draws most: the RF
     * calibration during boot, and the DHCP exchange when joining.
     *
     * 13 dBm brings the peak inside the budget and still covers a classroom.
     * Lower power means shorter range.
     */
    //% block="WiFi transmit power %dbm dBm"
    //% dbm.min=10 dbm.max=20 dbm.defl=13
    //% group="Hub"
    //% weight=85
    //% advanced=true
    export function setTxPower(dbm: number) {
        if (dbm < 10) dbm = 10
        if (dbm > 20) dbm = 20
        // AT+RFPOWER counts in quarter-dBm.
        txPowerQuarterDbm = Math.round(dbm * 4)
    }

    /**
     * Run code for every debug line (AT traffic and status messages), for
     * troubleshooting. Without this block, no debug text is built or sent.
     *
     * Do NOT write the line to the built-in serial: that port is connected to
     * the WiFi module. Use a second UART instead, e.g. the extra-serial
     * extension on the USB pins.
     */
    //% block="on WiFi debug message $line"
    //% draggableParameters="reporter"
    //% group="Status"
    //% weight=70
    //% advanced=true
    export function onDebugMessage(handler: (line: string) => void) {
        debugHandler = handler
    }

    // Send the configured power, if any. Called after AT+SYSSTORE in both the
    // hub and the node setup, so it is in force before the radio is used in
    // anger. Ignored (ERROR) on firmware without AT+RFPOWER, which is harmless.
    function applyTxPower() {
        if (txPowerQuarterDbm <= 0) return
        sendAtCmd("AT+RFPOWER=" + txPowerQuarterDbm)
        waitAt("OK", "ERROR", "None", 1000)
    }

    /**
     * Name the hub mini's own row on the dashboard and in the log
     * (default: the mini's device name with " (hub)", e.g. "zutip (hub)").
     */
    //% block="set hub name %name"
    //% name.defl="hub"
    //% group="Hub"
    //% weight=86
    //% advanced=true
    export function setHubName(name: string) {
        hubName = name
    }

    /**
     * Log the hub mini's own values. They show up on the page like a node's,
     * under the hub name ("<device name> (hub)" unless changed with
     * "set hub name"), and go
     * into the flash log with the nodes' rows. Use the same names as the
     * nodes, so they share a chart.
     */
    //% block="log hub values $d1||$d2 $d3 $d4 $d5"
    //% blockId=wifiliveloghubvalues
    //% d1.shadow=dataloggercreatecolumnvalue
    //% d2.shadow=dataloggercreatecolumnvalue
    //% d3.shadow=dataloggercreatecolumnvalue
    //% d4.shadow=dataloggercreatecolumnvalue
    //% d5.shadow=dataloggercreatecolumnvalue
    //% inlineInputMode="variable"
    //% inlineInputModeLimit=1
    //% group="Hub"
    //% weight=95
    export function logHubValues(d1: datalogger.ColumnValue, d2?: datalogger.ColumnValue, d3?: datalogger.ColumnValue, d4?: datalogger.ColumnValue, d5?: datalogger.ColumnValue) {
        let cvs = [d1, d2, d3, d4, d5].filter(el => !!el)
        let readings = ""
        for (let i = 0; i < cvs.length; i++) {
            if (readings.length > 0) readings += ","
            readings += cvs[i].column + "=" + cvs[i].value
        }
        record(hubName.length > 0 ? hubName : control.deviceName() + " (hub)", readings, cvs)
    }

    /**
     * State of a switch on the dashboard (on = true).
     *
     * Works on the hub and on every node. The page sends the switches and
     * sliders to the hub on every poll (about every 2 s); a node gets them
     * back with each "send values", so it sees changes at the pace it sends.
     */
    //% block="web switch %which"
    //% group="Controls"
    //% weight=60
    export function webToggle(which: LiveControl): boolean {
        return ctrlToggle[which]
    }

    /**
     * Value of a slider on the dashboard, 0 to 100. Works on the hub and on
     * every node (a node gets it with each "send values").
     */
    //% block="web slider %which"
    //% group="Controls"
    //% weight=59
    export function webSlider(which: LiveControl): number {
        return ctrlSlider[which]
    }

    /** The address to open in a browser, e.g. "10.0.0.1". */
    //% block="live page address"
    //% group="Status"
    //% weight=80
    //% advanced=true
    export function liveAddress(): string {
        return AP_IP
    }

    /** True if the WiFi network came up and the hub is serving. */
    //% block="live hub OK?"
    //% group="Status"
    //% weight=79
    //% advanced=true
    export function liveHubOK(): boolean {
        return apReady && running
    }

    /** How many different minis have sent readings. */
    //% block="number of nodes"
    //% group="Status"
    //% weight=78
    //% advanced=true
    export function nodeCount(): number {
        return nodeNames.length
    }

    /** Total readings received since the hub started. */
    //% block="readings received"
    //% group="Status"
    //% weight=77
    //% advanced=true
    export function readingsCount(): number {
        return pushCount
    }

    // ==================================================================
    // Node
    // ==================================================================

    /**
     * Join the hub's WiFi network (station mode). Use the same name and
     * password given to "start hub". The mini appears on the dashboard
     * under its own device name. Check "joined hub?" afterwards.
     */
    //% block="join hub|network name %name|password %pass||TX %tx|RX %rx"
    //% tx.defl=SerialPin.C17
    //% rx.defl=SerialPin.C16
    //% name.defl="CalliopeHub"
    //% expandableArgumentMode="toggle"
    //% group="Node"
    //% weight=70
    export function joinHub(name: string, pass: string, tx?: SerialPin, rx?: SerialPin): void {
        // Every mini is shown under its own five-letter device name.
        myNodeName = control.deviceName()
        setPins(tx, rx)
        ssid = name
        passwd = pass
        joined = false
        startSetupAnim(1)
        openSerial()

        // The module may still be booting; anything sent now would be lost.
        // No point configuring a module that is not answering: the join would
        // fail 3 x 20 s later with nothing to show for it.
        if (!wakeModule()) {
            note("node: module not responding")
            endSetupAnim(false)
            return
        }

        applyLinkSpeed()
        sendAtCmd("AT+SYSSTORE=0")
        waitAt("OK", "ERROR", "FAIL", 3000)
        applyTxPower()
        sendAtCmd("AT+CWMODE=1")
        waitAt("OK", "ERROR", "None", 1000)
        // Undo hub state left on the module: reflashing the mini does not
        // power-cycle it, so after a hub program it still runs CIPSERVER with
        // CIPMUX=1. Then CIPMUX=0 is refused and every CIPSTART without a link
        // id answers ERROR. ",1" also closes all connections, which CIPMUX=0
        // needs too. ERROR here just means no server was running.
        sendAtCmd("AT+CIPSERVER=0,1")
        waitAt("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+CIPMUX=0")
        waitAt("OK", "ERROR", "None", 1000)

        for (let a = 0; a < 3 && !joined; a++) {
            sendAtCmd("AT+CWJAP=\"" + name + "\",\"" + pass + "\"")
            if (waitAt("WIFI GOT IP", "ERROR", "None", 20000) == 1) joined = true
            else basic.pause(500)
        }
        endSetupAnim(joined)
        note(joined ? "node: joined " + name : "node: join FAILED")
    }

    /** True if this mini joined the hub's network. */
    //% block="joined hub?"
    //% group="Status"
    //% weight=69
    //% advanced=true
    export function joinedHub(): boolean {
        return joined
    }

    /**
     * Send this mini's current values to the hub, under its device name.
     * Values replace whatever was sent before, so the page
     * always shows the latest. "last send status" tells whether it arrived.
     */
    //% block="send values $d1||$d2 $d3 $d4 $d5"
    //% blockId=wifilivesendvalues
    //% d1.shadow=dataloggercreatecolumnvalue
    //% d2.shadow=dataloggercreatecolumnvalue
    //% d3.shadow=dataloggercreatecolumnvalue
    //% d4.shadow=dataloggercreatecolumnvalue
    //% d5.shadow=dataloggercreatecolumnvalue
    //% inlineInputMode="variable"
    //% inlineInputModeLimit=1
    //% group="Node"
    //% weight=68
    export function sendValues(d1: datalogger.ColumnValue, d2?: datalogger.ColumnValue, d3?: datalogger.ColumnValue, d4?: datalogger.ColumnValue, d5?: datalogger.ColumnValue): void {
        let cvs = [d1, d2, d3, d4, d5].filter(el => !!el)
        let q = "node=" + enc(myNodeName.length > 0 ? myNodeName : control.deviceName())
        for (let i = 0; i < cvs.length; i++) {
            q += "&" + enc(cvs[i].column) + "=" + enc(cvs[i].value)
        }
        // Do not push over a link that is not up. Hardware log showed 39
        // consecutive failures doing exactly that: the node had never joined (or
        // had been dropped -- 8x WIFI CONNECTED but only 2x WIFI GOT IP), and
        // every push still ran a full CIPCLOSE/CIPMUX/CIPSTART x2 sequence
        // against nothing. That AT churn is what drove the module into
        // "busy p..." where it stopped answering even a plain AT.
        if (!joined) {
            rejoin()
            if (!joined) {
                pushStage = 1
                note("push skipped: not joined")
                return
            }
        }

        let ok = pushQuery(q)
        if (!ok && pushStage == 1) {
            // Could not reach the hub. The usual cause is that the WiFi link
            // dropped underneath us, so try once to get it back -- otherwise the
            // node stays dead until the program is restarted.
            joined = false
            rejoin()
        }
        note(ok ? "push ok: " + q : "push FAILED (" + failReason() + ")")
    }

    /**
     * Where the last send got to: 0 = ok, 1 = no connection to the hub,
     * 2 = no send prompt, 3 = not acknowledged.
     */
    //% block="last send status"
    //% group="Status"
    //% weight=67
    //% advanced=true
    export function pushStatus(): number {
        return pushStage
    }

    // Re-join the network we were told about, at most every REJOIN_MS.
    //
    // The rate limit is essential: a FAILING join is expensive -- three CWJAP
    // attempts at a 20 s timeout each, so up to ~60 s. Two details matter and
    // both were got wrong first time:
    //   * the window must exceed that worst case, or the next push rejoins
    //     immediately and the node does nothing but join;
    //   * lastRejoin is stamped AFTER the attempt, not before, so the wait is
    //     measured from when we stopped trying rather than when we started.
    const REJOIN_MS = 30000
    function rejoin() {
        if (ssid.length == 0) return              // joinHub was never called
        if (lastRejoin != 0 && (input.runningTime() - lastRejoin) < REJOIN_MS) return
        note("node: link lost, rejoining " + ssid)
        setupAnim = false
        joinHub(ssid, passwd, txPin, rxPin)
        setupAnim = true
        lastRejoin = input.runningTime()
    }

    function failReason(): string {
        if (pushStage == 1) return "no connection"
        if (pushStage == 2) return "no prompt"
        if (pushStage == 3) return "not acknowledged"
        return "unknown"
    }

    // Short-lived TCP connection to the hub: connect, send, close. Never holds
    // one of the hub's five slots between pushes.
    function pushQuery(query: string): boolean {
        let ok = false
        sendAtCmd("AT+CIPCLOSE")
        waitAt("OK", "ERROR", "CLOSED", 1000)
        sendAtCmd("AT+CIPMUX=0")             // client mode: no link id
        waitAt("OK", "ERROR", "None", 1000)

        pushStage = 1
        let retry = 2
        while (retry > 0 && !ok) {
            retry--
            serial.readString()              // drop a late CLOSED from last time
            sendAtCmd("AT+CIPSTART=\"TCP\",\"" + hubHost + "\",80")
            let r = waitAt("CONNECT", "ALREADY CONNECTED", "ERROR", 5000)
            if (r != 1 && r != 2) { basic.pause(300); continue }

            pushStage = 2
            let req = "GET /p?" + query + " HTTP/1.1\r\nHost: " + hubHost + "\r\nConnection: close\r\n\r\n"
            sendAtCmd("AT+CIPSEND=" + req.length)
            // Wait for ">" only: "ERROR" as a target would match the echo of our
            // own command and abort a send that was about to succeed.
            if (!waitPrompt(3000)) {
                sendAtCmd("AT+CIPCLOSE")
                waitAt("OK", "ERROR", "CLOSED", 1000)
                continue
            }

            pushStage = 3
            serial.writeString(req)
            r = waitAt("SEND OK", "SEND FAIL", "ERROR", 5000)
            if (r == 1) readControlsReply()
            sendAtCmd("AT+CIPCLOSE")
            waitAt("OK", "ERROR", "CLOSED", 1000)
            // Let the teardown finish, or the NEXT connect races it and the
            // module refuses the send with a stale "CLOSED ... ERROR".
            basic.pause(200)
            serial.readString()
            if (r == 1) { ok = true; pushStage = 0 }
        }
        return ok
    }

    function waitPrompt(timeout: number): boolean {
        let buf = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < timeout) {
            buf += serial.readString()
            if (buf.includes(">")) { log(buf); return true }
            basic.pause(5)
        }
        log(buf + " [NO PROMPT]")
        return false
    }

    function enc(s: string): string {
        let out = ""
        for (let i = 0; i < s.length; i++) {
            let c = s.charAt(i)
            if (c == " ") out += "%20"
            else if (c == "&") out += "%26"
            else if (c == "=") out += "%3D"
            else if (c == "+") out += "%2B"
            else if (c == "%") out += "%25"
            else if (c == "#") out += "%23"
            else if (c == "?") out += "%3F"
            else out += c
        }
        return out
    }

    // ==================================================================
    // Server
    // ==================================================================

    // Pick the module's UART pins. Both are optional block arguments; left
    // out, pxt passes them as NULL, not undefined, so test with "!", not
    // "=== undefined" (no SerialPin value is 0).
    function setPins(tx: SerialPin, rx: SerialPin) {
        txPin = !tx ? SerialPin.C17 : tx
        rxPin = !rx ? SerialPin.C16 : rx
    }

    // Move the built-in serial from USB to the module at 115200.
    function openSerial() {
        serial.redirect(txPin, rxPin, BaudRate.BaudRate115200)
        serialOffUsb = true
        serial.setRxBufferSize(254)
    }

    function apSetup() {
        startSetupAnim(0)
        openSerial()

        if (!wakeModule()) {
            apReady = false            // liveHubOK() then reports the truth
            note("hub: module not responding")
            endSetupAnim(false)
            return
        }

        applyLinkSpeed()
        sendAtCmd("AT+SYSSTORE=0")
        waitAt("OK", "ERROR", "FAIL", 3000)
        applyTxPower()

        apReady = false
        for (let a = 0; a < 5 && !apReady; a++) {
            sendAtCmd("AT+CWMODE=2")
            waitAt("OK", "ERROR", "None", 1000)
            basic.pause(400)                 // let the SoftAP subsystem come up
            const ch = apChannel()
            if (passwd.length >= 8) {
                sendAtCmd("AT+CWSAP=\"" + ssid + "\",\"" + passwd + "\"," + ch + ",3")
            } else {
                sendAtCmd("AT+CWSAP=\"" + ssid + "\",\"\"," + ch + ",0")
            }
            if (waitAt("OK", "ERROR", "None", 3000) == 1) apReady = true
            else basic.pause(500)
        }

        sendAtCmd("AT+CIPAP=\"" + AP_IP + "\",\"" + AP_IP + "\",\"255.255.255.0\"")
        waitAt("OK", "ERROR", "None", 2000)

        // Stop any server left running: AT+CIPSERVERMAXCONN below is rejected
        // while one exists, and SYSSTORE=0 does not clear it.
        sendAtCmd("AT+CIPSERVER=0")
        waitAt("OK", "ERROR", "None", 1000)

        sendAtCmd("AT+CIPMUX=1")
        waitAt("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+CIPSTO=10")
        waitAt("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+CIPSERVERMAXCONN=5")
        waitAt("OK", "ERROR", "None", 1000)

        for (let a = 0; a < 3; a++) {
            sendAtCmd("AT+CIPSERVER=1,80")
            if (waitAt("OK", "ERROR", "None", 1000) != 0) break
            basic.pause(300)
        }

        // Announce calliopehub.local. Stop it first: enabling it while it is
        // still running from an earlier setup (reflashing does not power-cycle
        // the module) answers ERROR. Best effort: if the firmware lacks
        // AT+MDNS, the hub still works on 10.0.0.1.
        sendAtCmd("AT+MDNS=0")
        waitAt("OK", "ERROR", "None", 1000)
        sendAtCmd("AT+MDNS=1,\"" + MDNS_NAME + "\",\"_http\",80")
        waitAt("OK", "ERROR", "None", 2000)

        lastRequestTime = input.runningTime()
        endSetupAnim(apReady)
        note(apReady ? "hub up: " + ssid + " on " + AP_IP : "hub FAILED to start")
    }

    function startBackgroundServer() {
        running = true
        if (loopAlive) return
        control.inBackground(function () {
            loopAlive = true
            while (running) {
                handleRequests()
                basic.pause(5)               // yield to the user's own code
            }
            loopAlive = false
        })
    }

    function handleRequests() {
        rxBuf += serial.readString()

        // The module prints "ready" when it reboots. Config is volatile
        // (SYSSTORE=0), so re-run setup or the hub is dead for good.
        if (rxBuf.indexOf("ready") >= 0) {
            rxBuf = ""
            note("module rebooted -- re-running setup")
            basic.pause(500)
            setupAnim = false
            apSetup()
            setupAnim = true
            return
        }

        let idx = rxBuf.indexOf("+IPD,")
        if (idx < 0) {
            if (rxBuf.length > 1024) rxBuf = rxBuf.substr(rxBuf.length - 256)
            idleWatchdog()
            return
        }
        let getPos = rxBuf.indexOf(":GET ", idx)
        if (getPos < 0) {
            if (rxBuf.length > 2048) rxBuf = ""
            idleWatchdog()
            return
        }

        let after = rxBuf.substr(idx + 5)
        let comma = after.indexOf(",")
        let linkId = comma > 0 ? after.substr(0, comma) : "0"

        let pathStart = getPos + 5
        let pathEnd = rxBuf.indexOf(" ", pathStart)
        if (pathEnd < 0) {                   // request line not complete yet
            if (rxBuf.length > 2048) rxBuf = ""
            idleWatchdog()
            return
        }
        let path = rxBuf.substr(pathStart, pathEnd - pathStart)

        // Consume this request INCLUDING its headers. A node push ends right
        // after the path, but a browser sends ~400 more bytes (Host, Accept,
        // User-Agent...). Leaving those in rxBuf -- and, worse, in the module's
        // UART queue -- meant the AT+CIPSEND below read header text while
        // hunting for the ">" prompt and timed out, so the page was never sent.
        // A request ends at the blank line after the headers.
        // Wait for the whole request to arrive BEFORE trimming. drainIdle appends
        // what it reads to rxBuf, so doing this first means the blank line that
        // ends the headers is actually present to be found -- and any following
        // request is preserved rather than cut away.
        if (rxBuf.indexOf("\r\n\r\n", pathEnd) < 0) drainIdle(120, 800)

        let endOfReq = rxBuf.indexOf("\r\n\r\n", pathEnd)
        if (endOfReq >= 0) {
            rxBuf = rxBuf.substr(endOfReq + 4)   // keep anything queued behind it
        } else {
            rxBuf = ""                            // headers never completed
        }

        serveRequest(linkId, path)
        lastRequestTime = input.runningTime()
    }

    function serveRequest(linkId: string, path: string) {
        // NOTE ordering: "/p" (node pushes) is tested before "/live", and
        // both before the catch-all page.
        if (path.indexOf("/p?") == 0 || path == "/p") {
            // A node pushed values. Answer with the dashboard controls, so
            // "web switch" / "web slider" work on the nodes too. Reply first,
            // then log: the node is waiting for the line, the flash write
            // is not urgent.
            serveText(linkId, controlsLine())
            ingest(path)
        } else if (path.indexOf("/live") == 0) {
            serveText(linkId, liveBody())
        } else if (path.indexOf("/controls") == 0) {
            serveResponse(linkId, httpResponse("200 OK", "application/json", controlsJson()))
        } else if (path.indexOf("/log.csv") == 0) {
            serveLogCsv(linkId)
        } else if (path.indexOf("/data") == 0) {
            // The poll carries the browser clock (t=) and the control values,
            // so only one request type is ever in flight.
            syncTimeFromQuery(path)
            applyControls(path)
            serveResponse(linkId, httpDataResponse(logRowsCsv(parseQueryInt(path, "from"))))
        } else if (path.indexOf("/favicon") == 0) {
            serveText(linkId, "")
        } else {
            servePage(linkId)
        }
    }

    // Store the readings for one node, replacing whatever it sent before.
    function ingest(path: string) {
        let q = path.indexOf("?")
        if (q < 0) return
        let parts = path.substr(q + 1).split("&")

        let name = ""
        let readings = ""
        let cvs: datalogger.ColumnValue[] = []
        for (let i = 0; i < parts.length; i++) {
            let eq = parts[i].indexOf("=")
            if (eq < 0) continue
            let k = dec(parts[i].substr(0, eq))
            let v = dec(parts[i].substr(eq + 1))
            if (k == "node") { name = v; continue }
            if (k.length == 0) continue
            if (readings.length > 0) readings += ","
            readings += k + "=" + v
            cvs.push(datalogger.createCV(k, v))
        }
        record(name, readings, cvs)
    }

    // Store one mini's readings: the live table, the node count and a
    // "node"-first row in the flash log (the dashboard reads it back). Shared by node pushes
    // (ingest) and the hub's own values (logHubValues), so both look the same
    // on the page.
    function record(name: string, readings: string, cvs: datalogger.ColumnValue[]) {
        if (name.length == 0 || readings.length == 0) return

        let slot = nodeNames.indexOf(name)
        if (slot < 0) {
            if (nodeNames.length >= MAX_NODES) return   // ignore extra minis
            nodeNames.push(name)
            nodeData.push("")
            nodeSeen.push(0)
            slot = nodeNames.length - 1
        }
        nodeData[slot] = readings
        nodeSeen[slot] = input.runningTime()
        pushCount++

        if (cvs.length > 0) {
            // Will this row add a column? Then MicroBitLog writes a new header
            // line right before it, and we read that back below rather than
            // guess the header: the log has its own columns too (the
            // datalogger turns on "Time (seconds)" by default and puts it
            // first), and guessing them shifted every column by one.
            let newCols = logCols.length == 0 || logCols.indexOf("node") < 0
            for (let j = 0; j < cvs.length && !newCols; j++) {
                if (logCols.indexOf(cvs[j].column) < 0) newCols = true
            }
            // "node" first, then the readings. Built in order rather than with
            // insertAt so this stays on the same String/Array methods the rest
            // of the driver already relies on.
            let row: datalogger.ColumnValue[] = [datalogger.createCV("node", name)]
            for (let j = 0; j < cvs.length; j++) row.push(cvs[j])
            lockLog()
            datalogger.logData(row)
            if (newCols) {
                // The new header is the second-to-last line: header, then row.
                let n = datalogger.getNumberOfRows()
                if (n >= 2) {
                    let h = headerFields(datalogger.getRows(n - 2, 1))
                    if (h) logCols = h
                }
            }
            unlockLog()
        }
        note("live " + name + ": " + readings)
    }

    // One line per node: "name,key=value,key=value". Built fresh each request;
    // with MAX_NODES it stays a few hundred bytes, far below the allocation size
    // that caused error 022 in the charting dashboard.
    function liveBody(): string {
        let out = ""
        for (let i = 0; i < nodeNames.length; i++) {
            out += nodeNames[i] + "," + nodeData[i] + "\n"
        }
        return out
    }

    function serveText(linkId: string, body: string) {
        let resp = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Connection: close\r\n\r\n" + body
        // Only close if the peer has not already gone. Closing a dead link
        // answers ERROR and, worse, that exchange can swallow the browser's next
        // request.
        if (sendChunk(linkId, resp) && !peerClosed) {
            sendAtCmd("AT+CIPCLOSE=" + linkId)
            waitAt("OK", "ERROR", "CLOSED", 500)
        }
    }

    // Timed, because "the page is slow" needs to be attributed: if the hub
    // reports ~1 s here while the phone shows 5 s, the remaining 4 s is the
    // browser and the air, not this code.
    function servePage(linkId: string) {
        let pageStart = input.runningTime()
        buildPage()
        let len = 0
        for (let i = 0; i < pageSegs.length; i++) len += pageSegs[i].length
        let head = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: " + len + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "Connection: keep-alive\r\n\r\n"
        if (!sendChunk(linkId, head)) return
        // Pack the small segments into <=CHUNK packets; never one big string.
        let buf = ""
        for (let i = 0; i < pageSegs.length; i++) {
            if (buf.length + pageSegs[i].length > CHUNK && buf.length > 0) {
                if (!sendChunk(linkId, buf)) return
                buf = ""
                basic.pause(5)
            }
            buf += pageSegs[i]
        }
        if (buf.length > 0) sendChunk(linkId, buf)
        note("page sent in " + (input.runningTime() - pageStart) + " ms")
    }

    function sendChunk(linkId: string, piece: string): boolean {
        peerClosed = false
        sendAtCmd("AT+CIPSEND=" + linkId + "," + piece.length)
        if (waitAt(">", "ERROR", "link is not valid", 1000) != 1) return false
        serial.writeString(piece)
        let ok = waitAt("SEND OK", "SEND FAIL", "ERROR", 2000) == 1
        // "Connection: close" means the browser hangs up as soon as it has the
        // body, so <id>,CLOSED usually arrives with the SEND OK.
        if (lastReply.indexOf(linkId + ",CLOSED") >= 0) peerClosed = true
        return ok
    }


    // Read until the line has been quiet for idleMs (or maxMs elapses), so a
    // request that is still streaming in is fully absorbed before we reply.
    // The pause matters: without it this starves the user's own code.
    function drainIdle(idleMs: number, maxMs: number) {
        let start = input.runningTime()
        let lastData = start
        while (input.runningTime() - start < maxMs) {
            let s = serial.readString()
            if (s.length > 0) {
                lastData = input.runningTime()
                // Keep everything: the tail of the current request's headers
                // (which handleRequests needs to find the blank line) and any
                // following request that arrived in the same read. Discarding
                // either made the browser's polls disappear.
                rxBuf += s
                // ...but do not let it grow without limit while nodes keep
                // pushing; fall back to the most recent request.
                if (rxBuf.length > 1024) {
                    let keep = lastIdx(rxBuf, "+IPD,")
                    rxBuf = keep > 0 ? rxBuf.substr(keep) : rxBuf.substr(rxBuf.length - 512)
                }
            }
            else if (input.runningTime() - lastData > idleMs) return
            basic.pause(5)
        }
    }

    // A browser that vanished leaves a half-open socket holding a slot. Re-fires
    // every idle period until traffic resumes.
    function idleWatchdog() {
        if (input.runningTime() - lastRequestTime > IDLE_RECOVER_MS) {
            sendAtCmd("AT+CIPCLOSE=5")       // link id 5 = all connections
            waitAt("CLOSED", "OK", "ERROR", 1000)
            lastRequestTime = input.runningTime()
        }
    }

    function buildPage() {
        if (pageSegs.length == 0) {
            pageSegs = [
                "<!DOCTYPE html><html lang=\"de\"><head>",
                "<meta charset=\"utf-8\">",
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
                // Inline (empty) icon: without it the browser fires a separate
                // GET /favicon.ico, and on this single-fibre server every extra
                // request is another full connect/serve/close cycle.
                "<link rel=\"icon\" href=\"data:,\">",
                "<title>Calliope mini Hub</title><style>",
                // Look follows the Calliope UI kit (storybook.calliope.cc, recipe
                // "IoT-Dashboard"): ink text, mist hairlines, 8 px radii, dark
                // control tiles, pill buttons. No web fonts -- the hub has no
                // internet -- so Roboto is used only when installed.
                ":root{--ink:#1b1c1d;--mut:#1b1c1db3;--mist:#e8edeb;--teal:#42c8c8;--tealD:#1d8286;--cond:\"Roboto Condensed\",\"Arial Narrow\",\"Roboto\",system-ui,sans-serif}",
                "*{box-sizing:border-box}",
                "body{font-family:\"Roboto\",system-ui,\"Segoe UI\",Helvetica,Arial,sans-serif;margin:0;color:var(--ink);background:#fff;line-height:1.4}",
                ".header-strip{height:6px;background:var(--teal)}",
                // One column, as wide as the old feed table, centred.
                ".wrap{max-width:60rem;margin:0 auto;padding:1.5rem 1rem 2rem;display:flex;flex-direction:column;gap:1rem}",
                "h1{font-family:var(--cond);font-size:1.5rem;font-weight:600;line-height:1.2;text-transform:uppercase;letter-spacing:.04em;margin:0 0 .25rem}",
                "h2{font-family:var(--cond);font-size:1.125rem;font-weight:600;line-height:1.2;text-transform:uppercase;letter-spacing:.04em;margin:0 0 .75rem}",
                ".card{border:1px solid var(--mist);border-radius:8px;background:#fff;padding:1rem;min-width:0}",
                // Steuerung: switches side by side, sliders side by side.
                ".grid{display:grid;gap:.75rem;grid-template-columns:repeat(3,minmax(0,1fr))}",
                "@media(max-width:36rem){.grid{grid-template-columns:1fr}}",
                ".w{position:relative;background:var(--ink);color:#fff;border-radius:8px;padding:.85rem 1rem;display:flex;flex-direction:column;gap:.6rem;min-width:0}",
                ".hd{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}",
                ".lbl{font-family:var(--cond);font-weight:600;font-size:1rem}",
                ".val{font-size:1.5rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}",
                // Switch: the whole tile is the label, so a tap anywhere flips it.
                ".sw{cursor:pointer;-webkit-tap-highlight-color:transparent}",
                ".sw input{position:absolute;opacity:0;width:0;height:0}",
                ".sw .st:after{content:\"AUS\"}",
                ".sw input:checked~.hd .st:after{content:\"EIN\"}",
                ".tr{position:relative;display:block;width:3rem;height:1.75rem;border:2px solid #fff9;border-radius:99px;transition:background-color .2s,border-color .2s}",
                ".tr:after{content:\"\";position:absolute;top:50%;left:4px;width:16px;height:16px;border-radius:99px;background:#fff9;transform:translateY(-50%);transition:transform .2s,width .2s,height .2s,background-color .2s}",
                ".sw input:checked~.tr{background:#fff;border-color:#fff}",
                ".sw input:checked~.tr:after{background:var(--ink);width:20px;height:20px;transform:translate(18px,-50%)}",
                ".sw input:focus-visible~.tr{outline:2px solid var(--teal);outline-offset:2px}",
                // Slider in the UI-kit style: thin track, round white thumb.
                ".w input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:1.75rem;margin:0;background:transparent;cursor:pointer}",
                ".w input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:#fff9}",
                ".w input[type=range]::-moz-range-track{height:4px;border-radius:99px;background:#fff9}",
                ".w input[type=range]::-moz-range-progress{height:4px;border-radius:99px;background:#fff}",
                ".w input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;margin-top:-8px;border-radius:99px;background:#fff;border:0;box-shadow:0 0 0 2px var(--ink)}",
                ".w input[type=range]::-moz-range-thumb{width:20px;height:20px;border-radius:99px;background:#fff;border:0;box-shadow:0 0 0 2px var(--ink)}",
                ".w input[type=range]:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:4px}",
                // Feed table.
                "table{border-collapse:collapse;width:100%;font-size:.875rem}",
                "th,td{padding:.5rem 1rem .5rem 0;border-bottom:1px solid var(--mist);text-align:left}",
                "th{color:var(--mut);font-weight:600;font-size:.8125rem;text-transform:uppercase;letter-spacing:.04em}",
                "td.v{font-variant-numeric:tabular-nums;font-weight:600}",
                "#meta{color:var(--mut);font-size:.875rem;margin:.5rem 0 0}",
                "#status{color:var(--mut);font-size:.875rem;margin:.5rem 0 0}",
                // The waiting state is what the user stares at, so make it
                // readable and visibly alive. Three dots fade in turn, animated
                // in CSS -- nothing is added to the 2 s poll and it keeps moving
                // even while a request is in flight.
                //
                // Opacity on three spans, NOT an animated content: property --
                // animating content is not supported everywhere and would simply
                // show no dots at all on the browsers that skip it.
                "#status.wait{color:var(--tealD);font-size:1rem;font-weight:700}",
                "#status .d{animation:b 1.2s infinite}",
                "#status .d:nth-child(2){animation-delay:.2s}",
                "#status .d:nth-child(3){animation-delay:.4s}",
                "@keyframes b{0%,60%,100%{opacity:.2}30%{opacity:1}}",
                "#full{display:none;color:#e53f4b;font-weight:700;font-size:.875rem;margin:.5rem 0 0}",
                ".dlrow{display:flex;justify-content:flex-end;margin-top:1rem}",
                // Pill button, UI-kit "secondary".
                "button{cursor:pointer;height:2.25rem;padding:0 1rem;border:2px solid var(--ink);border-radius:99px;background:transparent;color:var(--ink);font-family:var(--cond);font-size:.875rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}",
                "button:hover{background:#1b1c1d14}",
                "button:disabled{opacity:.4;cursor:default;background:transparent}",
                "#charts{display:flex;flex-direction:column;gap:1rem}",
                ".chart{border:1px solid var(--mist);border-radius:8px;padding:.75rem 1rem 1rem;min-width:0}",
                // Chart title as its own heading above the plot, not inside the SVG.
                ".ct{font-family:var(--cond);font-size:1.125rem;font-weight:600;line-height:1.2;margin:0 0 .75rem;padding-bottom:.5rem;border-bottom:1px solid var(--mist)}",
                "footer{color:var(--mut);font-size:.8125rem;text-align:center}",
                "</style></head><body>",
                "<header><div class=\"header-strip\"></div></header>",
                "<main class=\"wrap\"><h1>Calliope mini Hub</h1>",
                "<section id=\"ctrls\" class=\"card\"><h2>Steuerung</h2><div class=\"grid\">",
                "<label class=\"w sw\"><input type=\"checkbox\" id=\"tA\"><span class=\"hd\"><span class=\"lbl\">Schalter A</span><span class=\"val st\"></span></span><span class=\"tr\"></span></label>",
                "<label class=\"w sw\"><input type=\"checkbox\" id=\"tB\"><span class=\"hd\"><span class=\"lbl\">Schalter B</span><span class=\"val st\"></span></span><span class=\"tr\"></span></label>",
                "<label class=\"w sw\"><input type=\"checkbox\" id=\"tC\"><span class=\"hd\"><span class=\"lbl\">Schalter C</span><span class=\"val st\"></span></span><span class=\"tr\"></span></label>",
                "<div class=\"w\"><div class=\"hd\"><label class=\"lbl\" for=\"sA\">Regler A</label><span id=\"sAv\" class=\"val\">0</span></div><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sA\"></div>",
                "<div class=\"w\"><div class=\"hd\"><label class=\"lbl\" for=\"sB\">Regler B</label><span id=\"sBv\" class=\"val\">0</span></div><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sB\"></div>",
                "<div class=\"w\"><div class=\"hd\"><label class=\"lbl\" for=\"sC\">Regler C</label><span id=\"sCv\" class=\"val\">0</span></div><input type=\"range\" min=\"0\" max=\"100\" value=\"0\" id=\"sC\"></div>",
                "</div></section>",
                "<section class=\"card\"><h2>Feeds</h2>",
                "<table id=\"t\"><tr><th>Sensor</th><th>Wert</th></tr></table>",
                "<div id=\"meta\">Empfangene Pakete: <span id=\"pkts\">0</span></div>",
                "<div id=\"full\">Log voll!</div>",
                // The waiting indicator lives here, where the eye already is --
                // next to the values -- rather than far below the charts.
                "<div id=\"status\" class=\"wait\">warte auf Daten<span class=\"d\">.</span><span class=\"d\">.</span><span class=\"d\">.</span></div>",
                "<div class=\"dlrow\"><button id=\"dl\" onclick=\"dlCsv()\">Als CSV herunterladen</button></div>",
                "</section>",
                "<section class=\"card\"><h2>Dashboard</h2><div id=\"charts\"></div></section>",
                "<footer><span id=\"last\">Letzte Aktualisierung: nie</span> &middot; aktualisiert sich alle 2&nbsp;s &middot; live vom WiFi-Modul</footer></main>",
                "<script>",
                "var s=document.getElementById('status'),tbl=document.getElementById('t'),",
                "lu=document.getElementById('last'),charts=document.getElementById('charts'),",
                "full=document.getElementById('full'),pk=document.getElementById('pkts');",
                "var WAIT='warte auf Daten<span class=\"d\">.</span><span class=\"d\">.</span><span class=\"d\">.</span>';",
                "var cols=[],rowEls=[],rows=[],offset=-1;",
                "var inflight=false,ctrlReady=false,downloading=false;",
                // Multi-node: when the data has a "node" column, each row is tagged
                // with its sender and the dashboard groups by node (one chart line
                // per node). nodeIx<0 means single-source mode (original layout).
                "var nodeIx=-1,senIx=[],chB=[];",
                // Colour per node name, given on first sight and kept for the
                // page's life (also across header rebuilds). Taking it from the
                // node's position in the buffer swapped colours as old rows
                // dropped out of the 500-row buffer.
                "var nCol={},nCnt=0;",
                // Time column index, and the hub's clock info from the last poll.
                "var tIx=-1;",
                "function p2(n){return (n<10?'0':'')+n;}",
                "function hm(w){if(w==null||isNaN(w))return '\u2013';var d=new Date(w);return p2(d.getHours())+':'+p2(d.getMinutes());}",
                "var PAL=['#8bc220','#e8743b','#19a979','#945ecf','#cc3c5d','#d39c00'];",
                "function build(h){cols=h;",
                "for(var k=0;k<h.length;k++){if(h[k].toLowerCase()=='node')nodeIx=k;if(tIx<0&&h[k].toLowerCase().indexOf('time')==0)tIx=k;}",
                "if(nodeIx<0){",
                // Single-source: one table row + one chart per column (original).
                "for(var ci=0;ci<h.length;ci++){",
                "var tr=tbl.insertRow();tr.insertCell().textContent=h[ci];",
                "var vc=tr.insertCell();vc.className='v';",
                "var bx=document.createElement('div');bx.className='chart';charts.appendChild(bx);",
                "rowEls.push({v:vc,b:bx});}",
                "}else{",
                // Multi-node: one chart per sensor column (skip node + any time
                // column); the table is rebuilt each tick as Node x sensors.
                "for(var c2=0;c2<h.length;c2++){",
                "if(c2==nodeIx||h[c2].toLowerCase().indexOf('time')==0)continue;",
                "senIx.push(c2);",
                "var b2=document.createElement('div');b2.className='chart';charts.appendChild(b2);chB.push(b2);}",
                "}}",
                // The full-log download is a big response. It must NOT run next to
                // the /data poll: the single-fiber server can't serve two sockets at
                // once (the browser opens a 2nd connection and gets REFUSED/EMPTY).
                // So pause polling, wait out any in-flight poll, then fetch with the
                // socket to ourselves. A 30s abort keeps a stalled download from
                // freezing the page; polling resumes (and catches up) either way.
                "async function dlCsv(){if(downloading)return;downloading=true;",
                // Grey the button while the log is gathered, and keep it greyed
                // for at least 5 s so a click always gives visible feedback even
                // when the download finishes almost instantly.
                "var B=document.getElementById('dl'),t0=Date.now();",
                "if(B){B.disabled=true;B.textContent='sammle Daten...';}",
                "s.textContent='lade CSV...';",
                "var ac=new AbortController(),tmo=setTimeout(function(){ac.abort();},30000);try{",
                "while(inflight)await new Promise(function(r){setTimeout(r,50);});",
                "var resp=await fetch('/log.csv',{cache:'no-store',signal:ac.signal});",
                "var t=await resp.text();",
                "var a=document.createElement('a');a.download='calliope-log.csv';",
                "a.href=URL.createObjectURL(new Blob([t.replace(/,/g,';')],{type:'text/csv'}));a.click();",
                "s.textContent='CSV geladen';",
                "}catch(e){s.textContent='CSV-Download fehlgeschlagen';}",
                "finally{clearTimeout(tmo);",
                "var wait=5000-(Date.now()-t0);if(wait<0)wait=0;",
                "setTimeout(function(){if(B){B.disabled=false;B.textContent='Als CSV herunterladen';}downloading=false;},wait);",
                "}}",
                "function svg(title,a){",
                "var W=640,H=260,pl=48,pr=12,pt=10,pb=24,gw=W-pl-pr,gh=H-pt-pb,i,j;",
                "var s='<h3 class=\"ct\">'+title+'</h3><svg viewBox=\"0 0 '+W+' '+H+'\" width=\"100%\" style=\"display:block\">';",
                "if(a.length<2)return s+'<text x=\"'+pl+'\" y=\"'+(H/2)+'\" fill=\"#aaa\" font-family=\"sans-serif\" font-size=\"11\">sammle Daten...</text></svg>';",
                "var mn=Math.min.apply(null,a),mx=Math.max.apply(null,a);if(mn==mx){mn-=1;mx+=1;}",
                "function yf(v){return (pt+gh-((v-mn)/(mx-mn))*gh).toFixed(1);}",
                "function xf(q){return (pl+q/(a.length-1)*gw).toFixed(1);}",
                "s+='<path d=\"M'+pl+' '+pt+'L'+pl+' '+(pt+gh)+'L'+(pl+gw)+' '+(pt+gh)+'\" fill=\"none\" stroke=\"#ccc\"/>';",
                "var yl=[mx,(mx+mn)/2,mn];",
                "for(j=0;j<3;j++){var yy=yf(yl[j]);",
                "s+='<line x1=\"'+pl+'\" y1=\"'+yy+'\" x2=\"'+(pl+gw)+'\" y2=\"'+yy+'\" stroke=\"#eee\"/>';",
                "s+='<text x=\"2\" y=\"'+(+yy+3)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"11\">'+yl[j].toFixed(1)+'</text>';}",
                "var p='';for(i=0;i<a.length;i++)p+=xf(i)+','+yf(a[i])+' ';",
                "s+='<polyline fill=\"none\" stroke=\"#8bc220\" stroke-width=\"2\" points=\"'+p+'\"/>';",
                "var tk=4;for(i=0;i<=tk;i++){var f=i/tk,xx=(pl+f*gw).toFixed(1),ago=Math.round((1-f)*(a.length-1)*2);",
                "s+='<line x1=\"'+xx+'\" y1=\"'+(pt+gh)+'\" x2=\"'+xx+'\" y2=\"'+(pt+gh+3)+'\" stroke=\"#ccc\"/>';",
                "s+='<text x=\"'+xx+'\" y=\"'+(H-6)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"11\" text-anchor=\"'+(i==0?'start':i==tk?'end':'middle')+'\">'+(ago?'-'+ago+'s':'jetzt')+'</text>';}",
                "return s+'</svg>';}",
                // Multi-series chart: one labelled, coloured line per node.
                "function svgM(title,series,winLen){",
                // pt (top padding) leaves room for the column title AND the node legend
                // underneath it. At pt=22 the two sat 8 px apart and read as one
                // block; 32 separates them clearly. H grows to match so the plot
                // area itself is unchanged.
                "var W=640,H=280,pl=48,pr=12,pt=28,pb=24,gw=W-pl-pr,gh=H-pt-pb,i,k;",
                "var o='<h3 class=\"ct\">'+title+'</h3><svg viewBox=\"0 0 '+W+' '+H+'\" width=\"100%\" style=\"display:block\">';",
                "var all=[];for(k=0;k<series.length;k++)for(i=0;i<series[k].v.length;i++)all.push(series[k].v[i]);",
                "if(all.length<2)return o+'<text x=\"'+pl+'\" y=\"'+(H/2)+'\" fill=\"#aaa\" font-family=\"sans-serif\" font-size=\"11\">sammle Daten...</text></svg>';",
                "var mn=Math.min.apply(null,all),mx=Math.max.apply(null,all);if(mn==mx){mn-=1;mx+=1;}",
                "function yf(val){return (pt+gh-((val-mn)/(mx-mn))*gh).toFixed(1);}",
                // x is the position in the shared window, not within one series, so all
                // nodes share one time axis.
                "function xf(q){return (pl+(winLen<2?gw:q/(winLen-1)*gw)).toFixed(1);}",
                "o+='<path d=\"M'+pl+' '+pt+'L'+pl+' '+(pt+gh)+'L'+(pl+gw)+' '+(pt+gh)+'\" fill=\"none\" stroke=\"#ccc\"/>';",
                "var yl=[mx,(mx+mn)/2,mn];",
                "for(i=0;i<3;i++){var yy=yf(yl[i]);",
                "o+='<line x1=\"'+pl+'\" y1=\"'+yy+'\" x2=\"'+(pl+gw)+'\" y2=\"'+yy+'\" stroke=\"#eee\"/>';",
                "o+='<text x=\"2\" y=\"'+(+yy+3)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"11\">'+yl[i].toFixed(1)+'</text>';}",
                "for(k=0;k<series.length;k++){var a=series[k].v,ax=series[k].x,p='';for(i=0;i<a.length;i++)p+=xf(ax[i])+','+yf(a[i])+' ';",
                "o+='<polyline fill=\"none\" stroke=\"'+series[k].c+'\" stroke-width=\"2\" points=\"'+p+'\"/>';}",
                "var tk=4;for(i=0;i<=tk;i++){var f=i/tk,xx=(pl+f*gw).toFixed(1),ago=Math.round((1-f)*(winLen-1)*2);",
                "o+='<line x1=\"'+xx+'\" y1=\"'+(pt+gh)+'\" x2=\"'+xx+'\" y2=\"'+(pt+gh+3)+'\" stroke=\"#ccc\"/>';",
                "o+='<text x=\"'+xx+'\" y=\"'+(H-6)+'\" fill=\"#888\" font-family=\"sans-serif\" font-size=\"11\" text-anchor=\"'+(i==0?'start':i==tk?'end':'middle')+'\">'+(ago?'-'+ago+'s':'jetzt')+'</text>';}",
                "var lx=pl+4;for(k=0;k<series.length;k++){",
                "o+='<rect x=\"'+lx+'\" y=\"'+(pt-21)+'\" width=\"10\" height=\"10\" fill=\"'+series[k].c+'\"/>';",
                "o+='<text x=\"'+(lx+14)+'\" y=\"'+(pt-12)+'\" fill=\"#555\" font-family=\"sans-serif\" font-size=\"12\">'+series[k].n+'</text>';",
                "lx+=28+series[k].n.length*7;}",
                "return o+'</svg>';}",
                // Render the Node x sensors table and one per-sensor chart (a line
                // per node) from the buffered rows. Used when nodeIx>=0.
                "function renderN(){var seen={},nodes=[],i,j,k;",
                "for(i=0;i<rows.length;i++){var nv=rows[i][nodeIx];if(nv!==undefined&&seen[nv]===undefined){seen[nv]=1;nodes.push(nv);if(nCol[nv]===undefined)nCol[nv]=nCnt++;}}",
                // Same order everywhere (table, legend): order of first sight.
                "nodes.sort(function(a,b){return nCol[a]-nCol[b];});",
                "if(!nodes.length)return;",
                // One line per feed: the newest value of that feed, whichever
                // mini sent it, with that mini's name and when it came.
                "var h='<tr><th>Feed</th><th>Letzter Wert</th><th>Calliope mini</th><th>Zeit</th></tr>';",
                "for(j=0;j<senIx.length;j++){var ci=senIx[j],r=null;",
                "for(i=rows.length-1;i>=0;i--){var q=rows[i];if(q[ci]!==undefined&&q[ci]!==''){r=q;break;}}",
                "if(r)h+='<tr><td>'+cols[ci]+'</td><td class=\"v\">'+r[ci]+'</td><td>'+r[nodeIx]+'</td><td>'+hm(r.w)+'</td></tr>';}",
                "tbl.innerHTML=h;",
                "var win=rows.slice(-400);",
                "for(j=0;j<senIx.length;j++){var c2=senIx[j],series=[];",
                "for(k=0;k<nodes.length;k++){var v=[];",
                // Record each value with its index in the SHARED window, so a node that
                // joined late is drawn only over the span it was actually present
                // for. Keying off the series' own length instead stretched three
                // fresh points across the whole plot, back to "-42s".
                "var xs=[];",
                "for(i=0;i<win.length;i++){if(win[i][nodeIx]!=nodes[k])continue;var fv=parseFloat(win[i][c2]);if(!isNaN(fv)){v.push(fv);xs.push(i);}}",
                "series.push({n:nodes[k],c:PAL[nCol[nodes[k]]%PAL.length],v:v,x:xs});}",
                "chB[j].innerHTML=svgM(cols[c2],series,win.length);}}",
                "function ctrlQ(){return '&tA='+(elT[0].checked?1:0)+'&tB='+(elT[1].checked?1:0)+'&tC='+(elT[2].checked?1:0)+'&sA='+elS[0].value+'&sB='+elS[1].value+'&sC='+elS[2].value;}",
                "async function tick(){if(inflight||downloading)return;inflight=true;",
                "var ac=new AbortController(),tmo=setTimeout(function(){ac.abort();},5000);try{",
                "var ts=Math.floor(Date.now()/1000);",
                "var url=(offset<0?'/data?t='+ts:'/data?from='+offset+'&t='+ts)+(ctrlReady?ctrlQ():'');",
                "var resp=await fetch(url,{cache:'no-store',signal:ac.signal});",
                "full.style.display=(resp.headers.get('X-Log-Full')=='1')?'':'none';",
                "var tot=resp.headers.get('X-Total-Rows');if(tot!=null)pk.textContent=tot;",
                "var rc=parseInt(resp.headers.get('X-Row-Count')||'-1');",
                // Row count went backwards -> the device restarted/reset its log.
                // Our buffered rows are now stale; drop them and reseed next poll.
                "if(rc>=0&&offset>=0&&rc<offset){console.log('reset: Neustart erkannt rc='+rc+' offset='+offset);rows.length=0;offset=-1;return;}",
                "var t=await resp.text();",
                "var L=t.replace(/\\r/g,'').split('\\n'),nr=[],li;",
                "for(li=0;li<L.length;li++)if(L[li].length)nr.push(L[li].split(','));",
                "if(rc>=0)offset=rc;",
                // The header grows when a new reading name first arrives; the
                // hub sends its current header with every batch. Rebuild the
                // table and charts when it changes; buffered rows still line up
                // because columns are only ever appended.
                "if(nr.length&&nr[0].join(',')!=cols.join(',')){charts.innerHTML='';rowEls=[];senIx=[];chB=[];nodeIx=-1;tIx=-1;",
                "tbl.innerHTML='<tr><th>Sensor</th><th>Wert</th></tr>';build(nr[0]);}",
                // Skip the header lines the log inserts into the data when a
                // column is added (first field "node").
                // Clock time per row (r.w, ms): the hub's uptime now minus the
                // row's age. Line ri is log row g; rows from before this hub
                // start (g < X-Boot-Row) count from another boot -> no time.
                "var up=parseFloat(resp.headers.get('X-Uptime')),br=parseInt(resp.headers.get('X-Boot-Row')),tNow=Date.now();",
                "for(var ri=1;ri<nr.length;ri++){var nrw=nr[ri];if(nodeIx>=0&&nrw[nodeIx]=='node')continue;",
                "var g=rc-(nr.length-1)+ri;nrw.w=(tIx>=0&&!isNaN(up)&&!isNaN(br)&&g>=br)?tNow-(up-parseFloat(nrw[tIx])*1000):NaN;",
                // No hub time for this row (earlier boot, no time column): use
                // the PC clock at arrival, so Zeit is always filled.
                "if(isNaN(nrw.w))nrw.w=tNow;rows.push(nrw);}",
                "if(rows.length>500)rows.splice(0,rows.length-500);",
                "console.log('poll: X-Row-Count='+rc+' neueZeilen='+(nr.length>0?nr.length-1:0)+' offset='+offset+' puffer='+rows.length);",
                "if(!rows.length){s.className='wait';s.innerHTML=WAIT;return;}",
                "if(nodeIx>=0){renderN();}else{",
                "var d=rows.slice(-100),last=d[d.length-1],ci;",
                "for(ci=0;ci<cols.length;ci++){if(!rowEls[ci])continue;",
                "rowEls[ci].v.textContent=last[ci]!==undefined?last[ci]:'';",
                "var arr=[],di;for(di=0;di<d.length;di++){var f=parseFloat(d[di][ci]);arr.push(isNaN(f)?0:f);}",
                "rowEls[ci].b.innerHTML=svg(cols[ci],arr);}}",
                // One line only: "Letzte Aktualisierung: <time>" already says the
                // page is live, so the separate "aktualisiert" status was a
                // second line saying the same thing.
                "lu.textContent='Letzte Aktualisierung: '+new Date().toLocaleTimeString();",
                "s.className='';s.textContent='';",
                "}catch(e){s.className='wait';s.innerHTML=WAIT;}",
                "finally{clearTimeout(tmo);inflight=false;}}",
                "var elT=[document.getElementById('tA'),document.getElementById('tB'),document.getElementById('tC')];",
                "var elS=[document.getElementById('sA'),document.getElementById('sB'),document.getElementById('sC')];",
                "var elSv=[document.getElementById('sAv'),document.getElementById('sBv'),document.getElementById('sCv')];",
                // Controls ride along on the next /data poll (no separate request,
                // so no collision with polling). Flipping a control triggers an
                // immediate tick() for snappy response; the inflight guard keeps
                // it from overlapping the periodic poll.
                "elT.forEach(function(e){e.addEventListener('change',tick);});",
                "elS.forEach(function(e,i){e.addEventListener('change',tick);e.addEventListener('input',function(){elSv[i].textContent=e.value;});});",
                // Control state is baked into the page instead of fetched. It is
                // already known when the page is built, and GET /controls was a
                // whole extra connect/serve/close cycle on a single-fibre server
                // -- pure latency on every page load.
                "elT[0].checked=" + (ctrlToggle[0] ? "true" : "false") + ";",
                "elT[1].checked=" + (ctrlToggle[1] ? "true" : "false") + ";",
                "elT[2].checked=" + (ctrlToggle[2] ? "true" : "false") + ";",
                "elS[0].value=" + ctrlSlider[0] + ";elS[1].value=" + ctrlSlider[1] + ";elS[2].value=" + ctrlSlider[2] + ";",
                "elSv[0].textContent=" + ctrlSlider[0] + ";elSv[1].textContent=" + ctrlSlider[1] + ";elSv[2].textContent=" + ctrlSlider[2] + ";",
                "ctrlReady=true;",
                "setInterval(tick,2000);tick();",
                "</script></body></html>",
            ]
        }
    }

    // The log's current header, kept by the hub: MicroBitLog only appends a
    // new header line to the data when a column is added after rows exist, so
    // row 0 (the first header) goes stale. Columns are only ever appended,
    // so older rows still line up with the newer, longer header.
    let logCols: string[] = []

    // The fields of a header line, or null if the line is not one. Our
    // headers always contain a "node" field (record() logs it); its position
    // depends on what the log put in front, e.g. the timestamp column.
    // One fibre at a time in the flash log. The hub writes from two fibres:
    // the server (node pushes) and the user's program (log hub values). The
    // datalogger locks each call on its own, not a whole row, so two rows
    // written at the same moment interleaved and left 0xFF holes in the log
    // (seen on hardware: every hole sat next to a hub row and a node row
    // logged 10-100 ms apart). CODAL's getNumberOfRows/getRows stop at the
    // first 0xFF, so after one hole the dashboard never saw a new row.
    // Fibres are cooperative: nothing runs between the test and the set.
    let logBusy = false
    function lockLog() {
        while (logBusy) basic.pause(1)
        logBusy = true
    }
    function unlockLog() {
        logBusy = false
    }
    function logRowCount(): number {
        lockLog()
        let n = datalogger.getNumberOfRows()
        unlockLog()
        return n
    }
    function logRows(from: number, n: number): string {
        lockLog()
        let r = datalogger.getRows(from, n)
        unlockLog()
        return r
    }

    function headerFields(line: string): string[] {
        let ln = line
        while (ln.length > 0 && (ln.charCodeAt(ln.length - 1) == 10 || ln.charCodeAt(ln.length - 1) == 13))
            ln = ln.substr(0, ln.length - 1)
        let f = ln.split(",")
        return f.indexOf("node") >= 0 ? f : null
    }

    // Seed logCols from a log that already exists, by finding its last header
    // line. A one-off scan at hub start, in batches so no big string is built.
    function loadLogCols() {
        logCols = []
        let total = logRowCount()
        const BATCH = 20
        for (let i = 0; i < total; i += BATCH) {
            let lines = logRows(i, BATCH).split("\n")
            for (let k = 0; k < lines.length; k++) {
                let h = headerFields(lines[k])
                if (h) logCols = h
            }
            basic.pause(1)
        }
    }

    function logRowsCsv(clientFrom: number): string {
        let total = logRowCount()   // includes header row 0
        let totalData = total - 1
        lastTotalRows = totalData > 0 ? totalData : 0   // total recorded rows -> X-Total-Rows
        if (total <= 1) { lastRowCount = 0; return "" }
        let startData: number
        if (clientFrom < 0) {
            // First connection: seed with the last SEED_ROWS data rows
            startData = totalData - SEED_ROWS
            if (startData < 0) startData = 0
        } else {
            // Diff: only rows the client hasn't seen yet
            if (clientFrom >= totalData) { lastRowCount = totalData; return "" }
            startData = clientFrom
        }
        let count = totalData - startData
        if (count > MAX_ROWS_PER_POLL) count = MAX_ROWS_PER_POLL
        lastRowCount = startData + count   // client's new cursor (may be < totalData)
        let startIdx = startData + 1       // +1 because row 0 is the header
        // No "node" header found (a log written by another program): fall back
        // to the log's own first header.
        let header = logCols.length > 0 ? logCols.join(",") : logRows(0, 1)
        return header + "\n" + logRows(startIdx, count)
    }

    function httpDataResponse(body: string): string {
        return "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/csv; charset=utf-8\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "X-Row-Count: " + lastRowCount + "\r\n" +
            "X-Total-Rows: " + lastTotalRows + "\r\n" +
            // With X-Uptime the page turns a row's "Time (seconds)" (since
            // this hub started) into a clock time.
            "X-Uptime: " + input.runningTime() + "\r\n" +
            "X-Boot-Row: " + bootRow + "\r\n" +
            "Connection: keep-alive\r\n\r\n" + body
    }

    function httpResponse(status: string, contentType: string, body: string): string {
        // Connection: keep-alive -> the browser reuses ONE socket for every poll
        // instead of reconnecting each time, avoiding the open/close churn that
        // fragments the module's heap and eventually reboots it.
        // X-Log-Full lets the page show a "log full" banner.
        return "HTTP/1.1 " + status + "\r\n" +
            "Content-Type: " + contentType + "; charset=utf-8\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "Connection: keep-alive\r\n\r\n" + body
    }

    function controlsJson(): string {
        return "{\"tA\":" + (ctrlToggle[0] ? "1" : "0") +
            ",\"tB\":" + (ctrlToggle[1] ? "1" : "0") +
            ",\"tC\":" + (ctrlToggle[2] ? "1" : "0") +
            ",\"sA\":" + ctrlSlider[0] +
            ",\"sB\":" + ctrlSlider[1] +
            ",\"sC\":" + ctrlSlider[2] + "}"
    }

    // The controls as one short line for the nodes: "C:" + three switch
    // digits + the three sliders, ended by ";". e.g. "C:101,50,0,100;"
    function controlsLine(): string {
        return "C:" + (ctrlToggle[0] ? "1" : "0") + (ctrlToggle[1] ? "1" : "0") +
            (ctrlToggle[2] ? "1" : "0") + "," + ctrlSlider[0] + "," +
            ctrlSlider[1] + "," + ctrlSlider[2] + ";"
    }

    // Node side: take the controls out of the hub's reply to a push. Returns
    // false if the line is not (yet) complete in buf.
    function parseControlsLine(buf: string): boolean {
        let a = buf.indexOf("C:")
        if (a < 0) return false
        let b = buf.indexOf(";", a)
        if (b < 0) return false
        let f = buf.substr(a + 2, b - a - 2).split(",")
        if (f.length != 4 || f[0].length != 3) return false
        for (let i = 0; i < 3; i++) {
            ctrlToggle[i] = f[0].charAt(i) == "1"
            ctrlSlider[i] = clampPct(f[i + 1])
        }
        return true
    }

    // After a push: wait for the hub's reply and take the controls from it.
    // The hub answers at once, unless it is busy (a page load is ~1.2 s), so
    // give up after REPLY_MS and keep the last known values. A missing reply
    // does not make the push fail: the values did arrive (SEND OK).
    const REPLY_MS = 1500
    function readControlsReply() {
        let buf = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < REPLY_MS) {
            buf += serial.readString()
            if (parseControlsLine(buf)) { log(buf); return }
            if (buf.indexOf("CLOSED") >= 0) break     // hub closed, no line
            basic.pause(5)
        }
        log(buf + " [NO CONTROLS]")
    }

    function applyControls(path: string) {
        let q = path.indexOf("?")
        if (q < 0) return
        // Remember the state so the page cache is only dropped on a real change:
        // this runs on EVERY /data poll, and rebuilding 13 KB of page every 2 s
        // would be far worse than the round trip it replaced.
        let before = (ctrlToggle[0] ? "1" : "0") + (ctrlToggle[1] ? "1" : "0") + (ctrlToggle[2] ? "1" : "0")
            + ctrlSlider[0] + "," + ctrlSlider[1] + "," + ctrlSlider[2]
        let parts = path.substr(q + 1).split("&")
        for (let i = 0; i < parts.length; i++) {
            let eq = parts[i].indexOf("=")
            if (eq < 0) continue
            let key = parts[i].substr(0, eq)
            let val = parts[i].substr(eq + 1)
            if (key == "tA") ctrlToggle[0] = val == "1"
            else if (key == "tB") ctrlToggle[1] = val == "1"
            else if (key == "tC") ctrlToggle[2] = val == "1"
            else if (key == "sA") ctrlSlider[0] = clampPct(val)
            else if (key == "sB") ctrlSlider[1] = clampPct(val)
            else if (key == "sC") ctrlSlider[2] = clampPct(val)
        }
        // The page has the control values baked in (there is no /controls fetch
        // any more) and buildPage caches, so drop the cache when -- and only
        // when -- something actually changed. The next page load then starts
        // from the current state.
        let after = (ctrlToggle[0] ? "1" : "0") + (ctrlToggle[1] ? "1" : "0") + (ctrlToggle[2] ? "1" : "0")
            + ctrlSlider[0] + "," + ctrlSlider[1] + "," + ctrlSlider[2]
        if (after != before) pageSegs = []
    }

    function syncTimeFromQuery(path: string) {
        let t = parseQueryInt(path, "t")
        if (t > 0) {
            syncedEpochSec = t
            syncedDeviceMs = input.runningTime()
            timeSynced = true
        }
    }

    function parseQueryInt(path: string, key: string): number {
        let q = path.indexOf("?")
        if (q < 0) return -1
        let parts = path.substr(q + 1).split("&")
        for (let i = 0; i < parts.length; i++) {
            let eq = parts[i].indexOf("=")
            if (eq < 0) continue
            if (parts[i].substr(0, eq) == key) {
                let n = Math.round(parseFloat(parts[i].substr(eq + 1)))
                return isNaN(n) ? -1 : n
            }
        }
        return -1
    }

    function serveLogCsv(linkId: string) {
        let total = logRowCount()   // includes the header row
        let BATCH = 20
        let bodyLen = 0
        let i = 0
        let first = true
        while (i < total) {
            let n = total - i
            if (n > BATCH) n = BATCH
            if (!first) bodyLen += 1                 // the "\n" that joins batches
            bodyLen += logRows(i, n).length
            first = false
            i += n
        }
        let head = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: text/csv; charset=utf-8\r\n" +
            "Content-Length: " + bodyLen + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "X-Log-Full: " + (logFull ? "1" : "0") + "\r\n" +
            "Connection: keep-alive\r\n\r\n"
        if (!sendChunk(linkId, head)) return
        i = 0
        first = true
        while (i < total) {
            let n = total - i
            if (n > BATCH) n = BATCH
            let piece = (first ? "" : "\n") + logRows(i, n)
            if (!sendChunk(linkId, piece)) return
            first = false
            i += n
            basic.pause(5)
        }
    }

    // Send a prebuilt response in <=CHUNK pieces.
    function serveResponse(linkId: string, response: string) {
        let i = 0
        while (i < response.length) {
            if (!sendChunk(linkId, response.substr(i, CHUNK))) return
            i += CHUNK
            basic.pause(5)
        }
        if (!peerClosed) {
            sendAtCmd("AT+CIPCLOSE=" + linkId)
            waitAt("OK", "ERROR", "CLOSED", 500)
        }
    }

    function clampPct(s: string): number {
        let n = Math.round(parseFloat(s))
        if (isNaN(n)) return 0
        return Math.max(0, Math.min(100, n))
    }

    // ==================================================================
    // AT plumbing
    // ==================================================================

    // pxt's String has indexOf but NOT lastIndexOf, so scan forward for the last
    // occurrence. Returns -1 if absent.
    function lastIdx(hay: string, needle: string): number {
        let found = -1
        let from = 0
        while (true) {
            let i = hay.indexOf(needle, from)
            if (i < 0) return found
            found = i
            from = i + 1
        }
    }

    function dec(s: string): string {
        let out = ""
        let i = 0
        while (i < s.length) {
            let c = s.charAt(i)
            if (c == "+") { out += " "; i++ }
            else if (c == "%" && i + 2 < s.length) {
                out += String.fromCharCode(hexVal(s.charAt(i + 1)) * 16 + hexVal(s.charAt(i + 2)))
                i += 3
            } else { out += c; i++ }
        }
        return out
    }

    function hexVal(c: string): number {
        let n = c.charCodeAt(0)
        if (n >= 48 && n <= 57) return n - 48
        if (n >= 97 && n <= 102) return n - 87
        if (n >= 65 && n <= 70) return n - 55
        return 0
    }

    /**
     * Get the module answering AT, resetting it if it will not.
     *
     * Plugging the board in after the module has been cold produces a state
     * where every AT times out for ever -- not just during boot. Pressing the
     * module's own reset button clears it, which is the tell: the module is
     * powered and its UART accepts bytes, but its AT task never came up. A cold
     * start draws a large inrush (radio calibration) and a brown-out there can
     * leave it half-initialised; firmware 3.3.0.0 also lacks esp-at 371b9fc4,
     * the fix for "crash if an AT command arrives before AT is ready".
     *
     * Either way the software remedy is the same one the user was doing by hand:
     * send AT+RST and let it boot again with the supply already settled.
     *
     * Returns true once the module answers.
     */
    function wakeModule(): boolean {
        // First, the cheap case: it is simply still booting. A cold ESP32-C3
        // needs ~300-800 ms, so a few seconds of probing covers it.
        for (let i = 0; i < 12; i++) {
            sendAtCmd("AT")
            if (waitAt("OK", "ERROR", "None", 300) == 1) return true
            basic.pause(200)
        }

        // Still silent after ~6 s: it is wedged, not slow. Reset it -- this is
        // the reset button, in software. Two attempts, because the first reset
        // can itself land badly on a module that is brown-out prone.
        for (let attempt = 0; attempt < 2; attempt++) {
            note("module not answering -- AT+RST")
            sendAtCmd("AT+RST")
            basic.pause(1500)              // let it come back up
            serial.readString()            // drop the boot banner
            for (let i = 0; i < 20; i++) {
                sendAtCmd("AT")
                if (waitAt("OK", "ERROR", "None", 300) == 1) {
                    note("module awake after reset")
                    return true
                }
                basic.pause(200)
            }
        }
        note("module DEAD -- power-cycle it")
        return false
    }

    function sendAtCmd(cmd: string) {
        serial.writeString(cmd + "\u000D\u000A")
        // Not logged here: printing now would delay draining the module's reply
        // while it arrives and can overrun the RX buffer. waitAt prints both
        // once the reply is read.
        pendingCmd = cmd
    }

    function log(reply: string) {
        if (!debugHandler) return
        if (pendingCmd.length > 0) {
            debugLine(">>" + pendingCmd)
            pendingCmd = ""
        }
        debugLine("<<" + flatten(reply))
    }

    function note(msg: string) {
        if (!debugHandler) return
        debugLine(msg)
    }

    // Debug output goes to a handler the program registers (onDebugMessage),
    // so the extension itself has no dependency on extra-serial or any other
    // output. No handler = debug off, and no debug strings are built.
    // Lines before the module's serial has left the USB pins are dropped.
    let debugHandler: (line: string) => void = undefined
    function debugLine(msg: string) {
        if (!debugHandler || !serialOffUsb) return
        debugHandler(msg)
    }

    function flatten(s: string): string {
        let out = ""
        for (let i = 0; i < s.length; i++) {
            let c = s.charAt(i)
            if (c == "\r" || c == "\n") out += " "
            else out += c
        }
        return out
    }

    function waitAt(t1: string, t2: string, t3: string, timeout: number) {
        let buffer = ""
        let start = input.runningTime()
        while ((input.runningTime() - start) < timeout) {
            buffer += serial.readString()
            if (buffer.includes(t1)) { finishWait(buffer); return 1 }
            if (buffer.includes(t2)) { finishWait(buffer); return 2 }
            if (buffer.includes(t3)) { finishWait(buffer); return 3 }
            // 10 ms, not 100. An AT reply ("OK", ">", "SEND OK") comes back in a
            // millisecond or two, but at 100 ms granularity we slept through
            // nearly all of it. Two such waits per packet were costing
            // ~200-400 ms of the ~300-500 ms each packet took, while the bytes
            // themselves need only ~89 ms. Still yields to other fibres.
            basic.pause(10)
        }
        finishWait(buffer + " [TIMEOUT]")
        return 0
    }

    // Log the exchange, but FIRST rescue anything in it that was not an AT reply
    // at all.
    //
    // The module reuses link ids the instant a socket closes, so the browser's
    // next request routinely lands inside the reply to our AT+CIPCLOSE. waitAt
    // keeps its buffer locally and drops it on return, which destroyed that
    // request -- the page then never loaded, because every retry was eaten the
    // same way. Anything from "+IPD," onward is pushed back for handleRequests.
    function finishWait(buffer: string) {
        lastReply = buffer
        let i = buffer.indexOf("+IPD,")
        if (i >= 0) {
            rxBuf += buffer.substr(i)
            // Bound it. While a page is being sent, nodes keep pushing and each
            // CIPSEND's wait rescues whatever is in flight -- unbounded, that
            // grew faster than requests could be served and the page never
            // finished. Requests are small and idempotent (each push just
            // overwrites that node's slot), so dropping the oldest costs at most
            // one stale reading.
            if (rxBuf.length > 1024) {
                let keep = lastIdx(rxBuf, "+IPD,")
                rxBuf = keep > 0 ? rxBuf.substr(keep) : ""
            }
        }
        log(buffer)
    }
}
