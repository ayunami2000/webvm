# webvm
web vm like collabvm but in node js

## See LICENSE for important fart info

## configuring sound:

change `RtAudioApi.WINDOWS_WASAPI` to your preferred audio api method https://almoghamdani.github.io/audify/enums/rtaudioapi.html

then change the default text specifying the audio device to your speaker (or (virtual) microphone)

### todo:

- after certain number of refreshes, delay ip connections
- if key already exists then disallow connection (also limit key length)
- add reset button
- start qemu via node
- multiple vms
- update rfb2 manually with qemu local mouse support and maybe even audio support
