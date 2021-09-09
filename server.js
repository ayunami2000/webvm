var http = require('http');
var fs = require("fs");
var WebSocketServer = require('ws').Server;
const { RtAudio, RtAudioFormat, RtAudioStreamFlags, RtAudioApi } = require("audify");

var wsPort = 80;
var listeners = {};
var lockpos=[0,0];
var chatlog=[];
var unames={};
var wsc={};
var wsip={};
var recentips=[];
var turns=[];

var fps=20,
	mousefps=10,
	imgq={quality:0.25,progressive:true,chromaSubsampling:true};

var updloop=-1;

var rfb = require('rfb2');

const { createCanvas } = require('canvas')
const canvas = createCanvas(1,1);
const ctx = canvas.getContext('2d');
const cropcanvas=createCanvas(1,1),
	  cropctx=cropcanvas.getContext("2d");

var cachedliteraldata=[];
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
		//return [0,0,0,0];
		return [0,canvass.width-1,canvass.height-1,0];
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


var args = {
  host: '127.0.0.1',
  port: 5900
};
var r = rfb.createConnection(args);

r.on('connect', function() {
	canvas.width=r.width;
	canvas.height=r.height;
	updloop=setInterval(()=>r.requestUpdate(false, 0, 0, r.width, r.height),1000/fps);
});
r.on('resize', function(rect) {
	cachedliteraldata=[];
	canvas.width=rect.width;
	canvas.height=rect.height;
});
r.on('rect', function(rect) {
	if(rect.encoding==rfb.encodings.copyRect){
		ctx.putImageData(ctx.getImageData(rect.src.x,rect.src.y,rect.width,rect.height),rect.x,rect.y);
	}
  if(!rect.encoding==rfb.encodings.raw)return;
  var id = ctx.createImageData(rect.width,rect.height);
  var offset = 0;
  for (var i=0; i < rect.data.length; i += 4) {
	  id.data[offset++] = rect.data[i+2];
	  id.data[offset++] = rect.data[i+1];
	  id.data[offset++] = rect.data[i];
	  id.data[offset++] = 255;//rect.data[i+3];
  }
  ctx.putImageData(id, rect.x, rect.y);

  cropcanvas.width=rect.width;
  cropcanvas.height=rect.height;
  var check=checkIfCanvasNeedsToBeUpdated();
  if(check[0]){
	cropctx.globalCompositeOperation="source-over";
	cropctx.clearRect(0,0,cropcanvas.width,cropcanvas.height);
	cropctx.putImageData(check[1],0,0);
	var sides=detectDiff(cropcanvas);
	cropctx.globalCompositeOperation="source-in";
	cropcanvas.width-=sides[3]+sides[1];
	cropcanvas.height-=sides[0]+sides[2];
	cropctx.drawImage(canvas,rect.x,rect.y,rect.width,rect.height,-sides[3],-sides[0],cropcanvas.width+sides[3]+sides[1],cropcanvas.height+sides[0]+sides[2]);
	var cropbuffer=cropcanvas.toBuffer("image/jpeg",imgq);
	wss.clients.forEach(c=>c.send(JSON.stringify([rect.x+sides[3],rect.y+sides[0],cropbuffer.toString("base64"),r.width,r.height])));
  }
});
r.on('error', function(err) {
  console.error(err);
  clearInterval(updloop);
  r.end();
  process.exit(1);
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

var wss = new WebSocketServer({ server: httpServer });

function updchat(msg,silent){
	chatlog.push(msg);
	chatlog=chatlog.slice(chatlog.length-100);
	wss.clients.forEach(c=>c.send((silent?"^":"`")+chatlog[chatlog.length-1]));
}

//every 10s update whole screen
setInterval(()=>wss.clients.forEach(c=>c.send(JSON.stringify([0,0,canvas.toBuffer("image/jpeg",imgq).toString("base64"),r.width,r.height]))),10000);

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
	ws.send(JSON.stringify([0,0,canvas.toBuffer("image/jpeg",imgq).toString("base64"),r.width,r.height]));

	//control stuff
	ws.on('message', function (message) {
		//process.stdout.write(".");
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
		if(!("x" in jsonMsg&&"y" in jsonMsg&&"button" in jsonMsg&&"keydown" in jsonMsg&&"keyup" in jsonMsg&&"lock" in jsonMsg))return ws.close();
		if((turns.length==0?null:turns[0])!=connectionId){
			return;
		}
		jsonMsg.click=!!jsonMsg.click;
		jsonMsg.lock=!!jsonMsg.lock;
		jsonMsg.button=+jsonMsg.button||0;
		if(jsonMsg.keydown!=null)jsonMsg.keydown=+jsonMsg.keydown;
		if(jsonMsg.keyup!=null)jsonMsg.keyup=+jsonMsg.keyup;

		if(jsonMsg.lock){
			lockpos=[lockpos[0]+jsonMsg.x,lockpos[1]+jsonMsg.y];
			jsonMsg.x=lockpos[0];
			jsonMsg.y=lockpos[1];
		}else{
			lockpos=[jsonMsg.x,jsonMsg.y];
		}
		jsonMsg.x=Math.min((+jsonMsg.x)||-1,r.width);
		jsonMsg.y=Math.min((+jsonMsg.y)||-1,r.height);
		if(jsonMsg.x==-1||jsonMsg.y==-1)return;//dont move mouse but keep ws open
		//move mouse
		r.pointerEvent(jsonMsg.x,jsonMsg.y,jsonMsg.button);
		//press keys
		if(jsonMsg.keydown!=null)r.keyEvent(jsonMsg.keydown,1);
		//release keys
		if(jsonMsg.keyup!=null)r.keyEvent(jsonMsg.keyup,0);

		//minecraft lol
		lockpos=[canvas.width/2,canvas.height/2];
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

const rtAudio = new RtAudio(RtAudioApi.WINDOWS_WASAPI);
rtAudio.openStream(null,
	{ deviceId: rtAudio.getDevices().map(e=>e.name.trim()).indexOf(/*"CABLE Output (VB-Audio Virtual Cable)"*/"Virtual Audio Input (VB-Audio Virtual Cable)"),//rtAudio.getDefaultOutputDevice(),
	  nChannels: 2,
	  firstChannel: 0
	},
	RtAudioFormat.RTAUDIO_SINT16,
	22050,
	250*22050/1000,//50*22050/1000,// Frame size is 50ms
	"webvm",
	pcm => {
		if(!pcm.every(p=>p==0x00))wss.clients.forEach(c=>{
			c.send(pcm,{binary:true});
		});
	},null,RtAudioStreamFlags.RTAUDIO_MINIMIZE_LATENCY,e=>{if(!rtAudio.isStreamRunning())rtAudio.start();}
);

rtAudio.start();


const pixelmatch = require('pixelmatch');

function checkIfCanvasNeedsToBeUpdated(){
	if(cachedliteraldata.length==0){
		cachedliteraldata=ctx.getImageData(0,0,canvas.width,canvas.height).data;
		return [false,null];
	}
	var diff=cropctx.createImageData(canvas.width,canvas.height);
	var canvasdata=ctx.getImageData(0,0,canvas.width,canvas.height).data;
	var res=pixelmatch(cachedliteraldata,canvasdata,diff.data,canvas.width,canvas.height,{threshold:0.1})>50;
	if(res)cachedliteraldata=canvasdata;
	return [res,diff];
}

var commands="help quit list ips username kick endturn turns";

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
	case "quit":
	  console.log("Exiting...");
	  process.exit();
	  break;
	default:
	  console.log("Unknown command!");
  }
  process.stdout.write("Command: ");
  readline.question();
});
