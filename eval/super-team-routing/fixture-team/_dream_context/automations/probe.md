---
id: auto_probe01
title: Probe weekly
agent: probe
face:
  shape: 1
  color: 6
mode: sched
enabled: true
schedule:
  days:
    - mon
  at: '08:00'
timeout_minutes: 15
catchup_hours: 6
output:
  dir: null
shared: false
notify: true
review: 'off'
---
## Job

Run the weekly signup funnel check.
