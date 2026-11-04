# Calliope mini Hub

Ein Calliope mini öffnet ein eigenes WiFi-Netzwerk. Andere Minis verbinden sich damit und senden Werte. PCs oder Tablets können sich mit diesem WiFi verbinden und sehen dann unter calliopehub.local ein Live-Dashboard mit Tabelle, Diagrammen, CSV-Download sowie Schaltern und Schiebereglern, die jeder Mini auslesen kann.

Hardware: Calliope mini v3 mit einem Calliope WiFi-Modul (ESP32-C3, ESP-AT-Firmware) am Grove-Anschluss A1.


## Hub

```typescript
wifiHub.startHub("CalliopeHub", "")
basic.forever(function () {
    wifiHub.logHubValues(datalogger.createCV("temp", input.temperature()))
    basic.pause(2000)
})
```

http://10.0.0.1 (oder http://calliopehub.local) auf einem Gerät in diesem Netzwerk öffnen.

## Mini

```typescript
wifiHub.joinHub("CalliopeHub", "", "node1")
basic.forever(function () {
    wifiHub.sendValues(datalogger.createCV("temp", input.temperature()))
    basic.pause(2000)
})
```

Jeder Wertname wird eine Spalte. Jeder Wert wird außerdem im Flash-Speicher des Hubs gespeichert (`MY_DATA.HTM`). Ein Hub zeigt bis zu 8 Minis.

`Web-Schalter` / `Web-Schieberegler` liefern die Bedienelemente des Dashboards, auf dem Hub und auf jedem Mini. Ein Mini bekommt sie bei jedem Senden.

## Fehlersuche

`wenn WiFi-Debug-Meldung` liefert den AT-Verkehr. Nicht auf `serial` schreiben, darüber läuft das Modul. [test.ts](test.ts) schickt die Meldungen mit extra-serial an USB.

#### Metadata (used for search, rendering)

* for PXT/calliopemini
