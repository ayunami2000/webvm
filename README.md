# webvm
web vm like collabvm but in node js

fart demo: https://webvm.glitch.me

## See LICENSE for important fart info

### sample qemu command:

`D:/qemu/qemu-system-x86_64.exe -L D:/qemu -qmp tcp:127.0.0.1:1984,server,nowait -accel hax -vnc :0 -device intel-hda -device hda-output -boot d -cdrom "D:/VirtualBox VMs/webconverger.iso" -m 3072 -net nic,model=virtio -net user -rtc base=localtime,clock=host -smp cores=4,threads=4 -usbdevice tablet -vga vmware`

### todo:

- after certain number of refreshes, delay ip connections
- if key already exists then disallow connection (also limit key length)
- add voting system
- multiple vms
