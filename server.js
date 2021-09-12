const http = require('http');
const fs = require("fs");
const WebSocketServer = require('ws').Server;
const telnetlib=require("telnetlib");
const VncClient=require("vnc-rfb-client");
const exec = require('child_process').exec;

const { createCanvas } = require('canvas')
const canvas = createCanvas(1,1);
const ctx = canvas.getContext('2d');

/*
D:/qemu/qemu-system-x86_64.exe -L D:/qemu -qmp tcp:127.0.0.1:1984,server,nowait -accel hax -device intel-hda -device hda-output -vnc :0 -boot d -cdrom "D:/VirtualBox VMs/slax-64bit-9.11.0.iso" -m 2048 -net nic,model=virtio -net user -rtc base=localtime,clock=host -smp cores=4,threads=4 -usbdevice tablet -vga vmware
D:/qemu/qemu-system-x86_64.exe -L D:/qemu -qmp tcp:127.0.0.1:1984,server,nowait -accel hax -device intel-hda -device hda-output -vnc :0 -boot d -cdrom "D:/VirtualBox VMs/more ISOs/geexbox-3.1-x86_64.iso" -m 2048 -net nic,model=e1000 -net user -rtc base=localtime,clock=host -smp cores=4,threads=4 -usbdevice tablet -vga vmware
D:/qemu/qemu-system-x86_64.exe -L D:/qemu -qmp tcp:127.0.0.1:1984,server,nowait -accel hax -vnc :0 -device intel-hda -device hda-output -hda D:/Documents/cvm/emulator/hda.img -m 3072 -net nic,model=e1000 -net user -rtc base=localtime,clock=host -smp cores=4,threads=4 -usbdevice tablet -vga vmware
D:/qemu/qemu-system-x86_64.exe -L D:/qemu -qmp tcp:127.0.0.1:1984,server,nowait -accel hax -vnc :0 -device intel-hda -device hda-output -boot d -cdrom "D:/VirtualBox VMs/webconverger.iso" -m 3072 -net nic,model=virtio -net user -rtc base=localtime,clock=host -smp cores=4,threads=4 -usbdevice tablet -vga vmware
*/

//remove -usbdevice tablet for pointer lock

var qemuproc=exec('D:/qemu/qemu-system-x86_64.exe -L D:/qemu -qmp tcp:127.0.0.1:1984,server,nowait -accel hax -vnc :0 -device intel-hda -device hda-output -boot d -cdrom "D:/VirtualBox VMs/webconverger.iso" -m 3072 -net nic,model=virtio -net user -rtc base=localtime,clock=host -smp cores=4,threads=4 -usbdevice tablet -vga vmware'),
	telqmp=null,
	wsPort = 80,
	listeners = {},
	lockpos=[0,0],
	oldbtn=[],
	chatlog=[],
	unames={},
	wsc={},
	wsip={},
	recentips=[],
	turns=[],
	cachedscreen="",
	cachedliteraldata=[],
	sleep=ms=>new Promise(a=>setTimeout(a,ms)),
	fps=20,
	mousefps=10,
	relSens=2,
	imgq={quality:0.25,progressive:true,chromaSubsampling:true},
	updloop=-1,
	oldsize=[],
	wss=null;

setTimeout(()=>{
	telqmp=telnetlib.createConnection({host:"127.0.0.1",port:1984},()=>{
		telqmp.write('{"execute":"qmp_capabilities"}');
		setInterval(()=>telqmp.write(""),0);//bullshit innit
	});
},250);

const checkIfNotSolid = tolerance => (pixels) => {
	let solid = false;
	for (let i = 0; i < pixels.length && !solid; i += 4) {
		//check if blue is 0 bc if so then it isnt gray
		solid=pixels[i+2]<=10&&pixels[i+3]>=250;
	}
	return !solid;
};

function detectDiff(canvass,tolerance){
	tolerance=tolerance||0;

	const isTransparent = checkIfNotSolid(tolerance);

	const contextt = canvass.getContext("2d");
	let pixels;

	let top = -1;
	do {
		++top;
		if(top === canvass.height)break;
		pixels = contextt.getImageData(0, top, canvass.width, 1).data;
	} while (isTransparent(pixels));

	if (top === canvass.height) {
		//throw new Error("Can't detect edges.");
		return [0,0,0,0];
		//return [0,canvass.width-1,canvass.height-1,0];
	}

	// Left
	let left = -1;
	do {
		++left;
		if(left === canvass.width)break;
		pixels = contextt.getImageData(left, top, 1, canvass.height - top).data;
	} while (isTransparent(pixels));

	// Bottom
	let bottom = -1;
	do {
		++bottom;
		if(bottom === canvass.height)break;
		pixels = contextt.getImageData(left, canvass.height - bottom - 1, canvass.width - left, 1).data;
	} while (isTransparent(pixels));

	// Right
	let right = -1;
	do {
		++right;
		if(right === canvass.width)break;
		pixels = contextt.getImageData(canvass.width - right - 1, top, 1, canvass.height - (top + bottom)).data;
	} while (isTransparent(pixels));

	return [top,right,bottom,left];
}

const vncOpts={
    encodings:[
        VncClient.consts.encodings.raw,
        VncClient.consts.encodings.pseudoDesktopSize,
        VncClient.consts.encodings.pseudoQemuAudio,
        VncClient.consts.encodings.pseudoQemuPointerMotionChange
    ],
    fps:0
};
var vncWaitingToConnect=false;
const vncClient=new VncClient(vncOpts);
const vncConnectOpts={host:'127.0.0.1',port:5900};
vncClient.connect(vncConnectOpts);

vncClient.on('audioStream',buffer=>{
	if(!buffer.every(p=>p==0x00))wss.clients.forEach(c=>{
		c.send(buffer,{binary:true});
	});
});
vncClient.on('connectTimeout',()=>{
	if(vncWaitingToConnect)return;
	vncWaitingToConnect=true;
    console.log('[vnc] connection timeout, waiting 8s and reconnecting...');
    vncClient.resetState();//idk lol
	setTimeout(()=>{
		vncWaitingToConnect=false;
		vncClient.connect(vncConnectOpts);
	},8000);
});
vncClient.on('closed',()=>{
	if(vncWaitingToConnect)return;
	vncWaitingToConnect=true;
    console.log('[vnc] disconnected, waiting 8s and reconnecting...');
    wss.clients.forEach(c=>c.send("`VM Disconnected. Reconnecting..."));
    setTimeout(()=>{
		vncWaitingToConnect=false;
		vncClient.connect(vncConnectOpts);
	},8000);
});
vncClient.on('frameUpdated',fb=>{
	if(vncClient.clientWidth!=oldsize[0]||vncClient.clientHeight!=oldsize[1])cachedliteraldata=[];
	oldsize=[vncClient.clientWidth,vncClient.clientHeight];
	canvas.width=vncClient.clientWidth;
	canvas.height=vncClient.clientHeight;
	var id = ctx.createImageData(canvas.width,canvas.height);
	var offset = 0;
	for (var i=0; i < fb.length; i += 4) {
		id.data[offset++] = fb[i];
		id.data[offset++] = fb[i+1];
		id.data[offset++] = fb[i+2];
		id.data[offset++] = 255;//fb[i+3];
	}
	ctx.putImageData(id,0,0);
	if(cachedscreen=="")cachedscreen=canvas.toBuffer("image/jpeg",imgq).toString("base64");
	var check=checkIfCanvasNeedsToBeUpdated();
	if(check[0]){
		cachedscreen=canvas.toBuffer("image/jpeg",imgq).toString("base64");//is always 1frame behind but thats ok
		if(check[1]==null){
			wss.clients.forEach(c=>c.send(JSON.stringify([0,0,cachedscreen,vncClient.clientWidth,vncClient.clientHeight])));
		}else{
			ctx.globalCompositeOperation="source-over";
			var tmpdata=ctx.getImageData(0,0,canvas.width,canvas.height);
			ctx.clearRect(0,0,canvas.width,canvas.height);
			ctx.putImageData(check[1],0,0);
			var sides=detectDiff(canvas);
			ctx.globalCompositeOperation="source-in";
			canvas.width-=sides[3]+sides[1];
			canvas.height-=sides[0]+sides[2];
			ctx.putImageData(tmpdata,-sides[3],-sides[0]);
			var cropbuffer=canvas.toBuffer("image/jpeg",imgq);
			wss.clients.forEach(c=>c.send(JSON.stringify([sides[3],sides[0],cropbuffer.toString("base64"),vncClient.clientWidth,vncClient.clientHeight])));
		}
	}
});

var httpServer = http.createServer((req,res)=>{
  if(["","/"].includes(req.url)){
	res.writeHead(200,{"Content-Type":"text/html;charset=utf8"});
	res.end(fs.readFileSync("index.html","utf8"));
  }else if(req.url=="/pcm-player.min.js"){
	res.writeHead(200,{"Content-Type":"application/javascript;charset=utf8"});
	res.end(fs.readFileSync("pcm-player.min.js","utf8"));
  }else if(req.url=="/chat.mp3"){
	res.writeHead(200,{"Content-Type":"audio/mpeg"});
	res.end(fs.readFileSync("chat.mp3"));
  }else{
	res.writeHead(404);
	res.end("404 Not Found");
  }
}).listen(wsPort);

wss = new WebSocketServer({ server: httpServer });

function updchat(msg,silent){
	chatlog.push(msg);
	chatlog=chatlog.slice(chatlog.length-100);
	wss.clients.forEach(c=>c.send((silent?"^":"`")+chatlog[chatlog.length-1]));
}

var turntimer=20,
	firstturn=null,
	turndate=Date.now(),
	lastRoundTimer=20;

setInterval(()=>{
	//whenever turn is added turn timer is started
	if(turns.length!=0){
		if(firstturn!=turns[0]){
			if(firstturn!=null&&Object.keys(wsc).includes(firstturn)&&wsc[firstturn].readyState==wsc[firstturn].OPEN)wsc[firstturn].send("&e");
			firstturn=turns[0];
			turntimer=20;
			updchat("Turn of user "+unames[firstturn]+" started! (20s)",1);
			if(Object.keys(wsc).includes(firstturn)&&wsc[firstturn].readyState==wsc[firstturn].OPEN)wsc[firstturn].send("&s");
		}
		if(turntimer<=0){
			turntimer=20;
			turns.shift();
		}else{
			turntimer-=(Date.now()-turndate)/1000;
		}
	}else{
		if(firstturn!=null){
			updchat("turn ended!",1);
			if(Object.keys(wsc).includes(firstturn)&&wsc[firstturn].readyState==wsc[firstturn].OPEN)wsc[firstturn].send("&e");
			firstturn=null;
			turntimer=20;
		}
		turntimer=20;
	}
	turndate=Date.now();
	if(lastRoundTimer!=Math.ceil(turntimer)){
		lastRoundTimer=Math.ceil(turntimer);
		turns.forEach((k,i)=>{
			if(Object.keys(wsc).includes(k)&&wsc[k].readyState==wsc[k].OPEN)wsc[k].send("&"+(i*20+lastRoundTimer));
		});
	}
},1000/fps);

wss.on('connection', function (ws, req) {
	var headerip=req.headers['x_forwarded_for']||req.headers['x-forwarded-for']||req.connection.remoteAddress;
	headerip=headerip.split(",",2)[0];
	if(recentips.includes(headerip)){
		ws.send("`You are ratelimited!");
		return ws.close();
	}
	if(Object.values(wsip).includes(headerip))return ws.close();
	var connectionId = req.headers['sec-websocket-key'];
	if(Object.keys(unames).includes(connectionId))return ws.close();
	wsc[connectionId]=ws;
	wsip[connectionId]=headerip;
	while(!(connectionId in unames)){
		var proposeduname="user"+Math.floor(Math.random()*99999);
		if(!Object.values(unames).includes(proposeduname))unames[connectionId]=proposeduname;
	}

	var reqcounter=0;

	//send uname
	ws.send("$"+unames[connectionId]);

	//update chat
	ws.send("`"+chatlog.join("\n"));

	//update screen
	if(vncClient._connected)ws.send(JSON.stringify([0,0,cachedscreen,vncClient.clientWidth,vncClient.clientHeight]));

	//control stuff
	ws.on('message', function (message) {
		var jsonMsg={};
		try{
			jsonMsg=JSON.parse(message);
		}catch(e){
			if(reqcounter==0){
				setTimeout(()=>{
					if(reqcounter>=5){
						recentips.push(wsip[connectionId]);
						ws.close();
					}else{
						reqcounter=0;
					}
				},1000);
			}
			reqcounter++;
			if(message=="&"){
				if(turns.includes(connectionId)){
					turns.splice(turns.indexOf(connectionId),1);
					ws.send("&e");
				}else{
					turns.push(connectionId);
					ws.send("^Turn queued. (est. time until: "+(turns.indexOf(connectionId)*20+(20-Math.ceil(turntimer)))+"s)");
					ws.send("&q");
				}
				return;
			}
			message=message.toString().slice(1);
			if(message.startsWith("/")){
				var args=message.slice(1).split(" ");
				switch(args[0]){
					case "help":
						ws.send("^Commands: /help /list /username /nick /turns");
						break;
					case "list":
						ws.send("^Users: "+Object.values(unames).join(" "));
						break;
					case "turns":
						ws.send("^Turns: "+turns.map(x=>unames[x]).join(", "));
						break;
					case "username":
					case "nick":
						if(args.length<2||args[1].trim().replace(/[^A-Za-z0-9_-]/g,"")==""){
							ws.send("^Usage: /"+args[0]+" <new>");
						}else{
							var oldname=unames[connectionId],
								newname=args[1].slice(0,25).replace(/[^A-Za-z0-9_-]/g,"");
							if(Object.values(unames).includes(newname)){
								ws.send("^Sorry, but someone else already has that username!");
							}else{
								unames[connectionId]=newname;
								updchat('User "'+oldname+'" is now "'+newname+'"',1);
								ws.send("$"+newname);
							}
						}
						break;
					default:
						ws.send("^Command not found.");
				}
			}else{
				//chat :D
				updchat(unames[connectionId]+": "+message.slice(0,250).replace(/\s+/g,' '));
			}
			return;
		}
		if(!vncClient._connected)return;
		if(!("x" in jsonMsg&&"y" in jsonMsg&&"button" in jsonMsg&&"keydown" in jsonMsg&&"keyup" in jsonMsg&&"lock" in jsonMsg&&"mm" in jsonMsg))return ws.close();
		if((turns.length==0?null:turns[0])!=connectionId){
			return;
		}
		jsonMsg.click=!!jsonMsg.click;
		jsonMsg.lock=!!jsonMsg.lock;
		if(!Array.isArray(jsonMsg.button)||jsonMsg.button.length!=8)jsonMsg.button=[false,false,false,false,false,false,false,false];
		if(jsonMsg.keydown!=null)jsonMsg.keydown=+jsonMsg.keydown;
		if(jsonMsg.keyup!=null)jsonMsg.keyup=+jsonMsg.keyup;
		jsonMsg.x=+jsonMsg.x||null;
		jsonMsg.y=+jsonMsg.y||null;
		jsonMsg.mm=!!jsonMsg.mm;

		if(jsonMsg.x!=null&&jsonMsg.y!=null){
			jsonMsg.x=+jsonMsg.x||0;
			jsonMsg.y=+jsonMsg.y||0;
			if(jsonMsg.lock){
				if(vncClient._relativePointer){
					lockpos=[lockpos[0]+jsonMsg.x,lockpos[1]+jsonMsg.y];
					jsonMsg.x=Math.max(-32767,Math.min(jsonMsg.x*relSens,32767));
					jsonMsg.y=Math.max(-32767,Math.min(jsonMsg.y*relSens,32767));
				}else{
					lockpos=[lockpos[0]+jsonMsg.x*relSens,lockpos[1]+jsonMsg.y*relSens];
					jsonMsg.x=Math.max(0,Math.min(lockpos[0],vncClient.clientWidth,65535));
					jsonMsg.y=Math.max(0,Math.min(lockpos[1],vncClient.clientHeight,65535));
				}
			}else{
				if(vncClient._relativePointer){
					var tmplp=[jsonMsg.x,jsonMsg.y];
					jsonMsg.x-=lockpos[0];
					jsonMsg.y-=lockpos[1];
					lockpos=tmplp;
					jsonMsg.x=Math.max(-32767,Math.min(jsonMsg.x,32767));
					jsonMsg.y=Math.max(-32767,Math.min(jsonMsg.y,32767));
				}else{
					jsonMsg.x=Math.max(0,Math.min(jsonMsg.x,vncClient.clientWidth,65535));
					jsonMsg.y=Math.max(0,Math.min(jsonMsg.y,vncClient.clientHeight,65535));
					lockpos=[jsonMsg.x,jsonMsg.y];
				}
			}
			//move mouse
			vncClient.sendPointerEvent(jsonMsg.x,jsonMsg.y,...jsonMsg.button.reverse());
		}
		//press keys
		if(jsonMsg.keydown!=null)vncClient.sendKeyEvent(jsonMsg.keydown,1);
		//release keys
		if(jsonMsg.keyup!=null)vncClient.sendKeyEvent(jsonMsg.keyup,0);
	});

	//user stuff
	updchat(unames[connectionId]+" connected",1);

	ws.on('close', function () {
	  if(recentips.includes(wsip[connectionId]))setTimeout(ip=>recentips.splice(recentips.indexOf(ip),1),10000,wsip[connectionId]);
	  updchat(unames[connectionId]+" disconnected",1);
	  delete unames[connectionId];
	  delete wsc[connectionId];
	  delete wsip[connectionId];
	  if(turns.includes(connectionId))turns.splice(turns.indexOf(connectionId),1);
	});
});

console.log('Listening on port:', wsPort);

const pixelmatch = require('pixelmatch');

function checkIfCanvasNeedsToBeUpdated(){
	if(cachedliteraldata.length==0){
		cachedliteraldata=ctx.getImageData(0,0,canvas.width,canvas.height).data;
		return [true,null];
	}
	var diff=ctx.createImageData(canvas.width,canvas.height);
	var canvasdata=ctx.getImageData(0,0,canvas.width,canvas.height).data;
	var res=pixelmatch(cachedliteraldata,canvasdata,diff.data,canvas.width,canvas.height,{threshold:0.1})>50;
	if(res)cachedliteraldata=canvasdata;
	return [res,diff];
}

var commands="help quit list ips username kick endturn turns reset";

var readline=require("readline").createInterface({input:process.stdin,output:process.stdout,prompt:"Command: ",completer:function(line){
  var completions=commands.split(" ");
  var hits=completions.filter((c)=>c.startsWith(line));
  var res=hits.length?hits:completions;
  var args=line.split(" ");
  if(args.length>1){
	var unamelist=Object.values(unames);
	res=args[args.length-1]==""?unamelist:unamelist.filter((c)=>c.startsWith(args[args.length-1]));
	res=res.map(c=>args.slice(0,-1).join(" ")+" "+c)
  }
  return [res,line];
}});

console.log("Commands: "+commands);
process.stdout.write("Command: ");
readline.on('line',cmd=>{
  var args=cmd.trim().split(" ");
  switch(args[0]){
	case "help":
	  console.log("Commands: "+commands);
	  break;
	case "list":
	  console.log("Users: "+Object.values(unames).join(" "));
	  break;
	case "ips":
	  console.log(Object.keys(unames).map(e=>unames[e]+": "+wsip[e]).join("\n"));
	  break;
	case "turns":
	  console.log("Turns: "+turns.map(x=>unames[x]).join(", "));
	  break;
	case "username":
	  if(args.length<3){
		console.log("usage: username <oldname> <newname>");
	  }else{
		if(Object.values(unames).includes(args[2])){
		  console.log("error: that user already exists!");
		}else{
		  var nind=Object.values(unames).indexOf(args[1]);
		  if(nind==-1){
			console.log("error: that user was not found!");
		  }else{
			var key=Object.keys(unames)[nind];
			unames[key]=args[2];
			updchat('User "'+args[1]+'" is now "'+args[2]+'"',1);
			if(wsc[firstturn].readyState==wsc[firstturn].OPEN)wsc[key].send("$"+args[2]);
			console.log('changed user "'+args[1]+'" to "'+args[2]+'"');
		  }
		}
	  }
	  break;
	case "kick":
	  if(args.length<2){
		console.log("usage: kick <username>");
	  }else{
		if(Object.values(unames).includes(args[1])){
		  var key=Object.keys(unames)[Object.values(unames).indexOf(args[1])];
		  if(wsc[firstturn].readyState==wsc[firstturn].OPEN)wsc[key].close();
		  console.log('kicked user "'+args[1]+'"!');
		}else{
		  console.log("error: that user does not exist!");
		}
	  }
	  break;
	case "endturn":
	  if(args.length<2){
		console.log("usage: endturn <username>");
	  }else{
		if(Object.values(unames).includes(args[1])){
		  var key=Object.keys(unames)[Object.values(unames).indexOf(args[1])];
		  var turnind=turns.indexOf(key);
		  if(turnind==-1){
			console.log("error: user is not taking a turn!");
		  }else{
			turns.splice(turnind,1);
		  }
		  console.log('ended turn of user "'+args[1]+'"!');
		}else{
		  console.log("error: that user does not exist!");
		}
	  }
	  break;
	case "reset":
	  console.log("Resetting VM...");
	  telqmp.write('{"execute":"system_reset"}');
	  break;
	case "quit":
	  console.log("Exiting...");
	  qemuproc.kill('SIGINT');
	  process.exit();
	  break;
	default:
	  console.log("Unknown command!");
  }
  process.stdout.write("Command: ");
  readline.question();
});
