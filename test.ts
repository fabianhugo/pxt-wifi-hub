// WiFi Live test program. Flash the same program to every mini, then pick the
// role after start-up while "?" is shown:
//   A + B  -> hub (opens the network, serves http://10.0.0.1)
//   A      -> node (joins the hub, sends values every 2 s)
// Each node appears on the dashboard under its own device name (five letters,
// e.g. "zavit"), so several nodes with this one program never clash.
//
// Debug output (AT traffic) appears on the mini's USB serial port, 115200 baud.

const NETWORK = "CalliopeHub"
const PASSWORD = ""          // empty = open network, else at least 8 characters

// Debug output (AT traffic) to USB serial at 115200 through extra-serial's
// second UART. extra-serial is only a test dependency of the extension.
let debugOpen = false
wifiHub.onDebugMessage(function (line) {
    if (!debugOpen) {
        extraserial.redirect(ExtraSerialPin.USB_TX, ExtraSerialPin.USB_RX, ExtraBaudRate.BaudRate115200)
        extraserial.setWriteLinePadding(0)   // default pads every line to 32 bytes
        debugOpen = true
    }
    extraserial.writeLine(line)
})

// Show the dashboard controls, the same on hub and nodes: switch A = red,
// B = green, C = blue on the RGB LED (mixed if several are on), slider A =
// LED brightness. The hub has them at once, a node with each send.
function showControls() {
    let c = 0
    if (wifiHub.webToggle(LiveControl.A)) c += 0xff0000
    if (wifiHub.webToggle(LiveControl.B)) c += 0x00ff00
    if (wifiHub.webToggle(LiveControl.C)) c += 0x0000ff
    if (c == 0) basic.turnRgbLedOff()
    else basic.setLedColor(c)
    led.setBrightness(Math.map(wifiHub.webSlider(LiveControl.A), 0, 100, 10, 255))
}

// ---- Hub: open the network, collect readings, serve http://10.0.0.1 ----
function runHub() {
    wifiHub.setTxPower(15)
    wifiHub.startHub(NETWORK, PASSWORD)
    basic.showIcon(wifiHub.liveHubOK() ? IconNames.Yes : IconNames.No)

    basic.forever(function () {
        showControls()
        basic.pause(200)
    })

    // The hub's own readings, every 2 s, shown on the page as "<device name> (hub)".
    basic.forever(function () {
        wifiHub.logHubValues(
            datalogger.createCV("Temperatur", input.temperature()),
            datalogger.createCV("Licht", input.lightLevel()))
        basic.pause(2000)
    })
}

// ---- Node: join the hub and send values every 2 s ----
function runNode() {
    wifiHub.joinHub(NETWORK, PASSWORD)
    basic.showIcon(wifiHub.joinedHub() ? IconNames.Yes : IconNames.No)

    basic.forever(function () {
        wifiHub.sendValues(
            datalogger.createCV("Temperatur", input.temperature()),
            datalogger.createCV("Licht", input.lightLevel()))
        showControls()
        basic.pause(2000)
    })
}

// ---- Pick the role ----
// Wait for a press, then remember every button seen down until all are
// released. A and B are rarely pressed in the same millisecond, and a quick
// tap may be over before a single later check, so one sample is not enough.
basic.showString("?")
while (!input.buttonIsPressed(Button.A) && !input.buttonIsPressed(Button.B)) {
    basic.pause(20)
}
let sawA = false
let sawB = false
while (input.buttonIsPressed(Button.A) || input.buttonIsPressed(Button.B)) {
    if (input.buttonIsPressed(Button.A)) sawA = true
    if (input.buttonIsPressed(Button.B)) sawB = true
    basic.pause(20)
}
let hub = sawA && sawB
let node = sawA && !sawB
basic.clearScreen()

if (hub) {
    runHub()
} else if (node) {
    runNode()
} else {
    // B alone: neither role. Show X; reset to choose again.
    basic.showIcon(IconNames.No)
}
