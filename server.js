'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── WORLD ────────────────────────────────────────────────────────────────────
const PORT  = 3000;
const TICK  = 1000 / 60;
const W     = 1280;
const H     = 720;
const SPEED = 3.8;
const STEER = 0.6;   // player steering force per tick

// ─── ROLE CONFIG ──────────────────────────────────────────────────────────────
const ROLE_CFG = {
  normal:     { hp: 110, radius: 20, colDmg: 10 },
  shadow:     { hp: 90,  radius: 20, colDmg: 10 },
  wukong:     { hp: 110, radius: 20, colDmg: 10 },
  death:      { hp: 120, radius: 20, colDmg: 10 },
  laser:      { hp: 85,  radius: 18, colDmg: 10 },
  tank:       { hp: 140, radius: 26, colDmg: 18 },
  ghost:      { hp: 90,  radius: 20, colDmg: 10 },
  vampire:    { hp: 100, radius: 20, colDmg: 10 },
  bomb:       { hp: 105, radius: 20, colDmg: 10 },
  berserker:  { hp: 90,  radius: 20, colDmg: 10 },
  zatan:      { hp: 100, radius: 20, colDmg: 10 },
  mummy:      { hp: 115, radius: 22, colDmg: 10 },
  troll:      { hp: 165, radius: 25, colDmg: 15, speedMult: 0.82 },
  dragon:     { hp: 105, radius: 22, colDmg: 12 },
  challenger: { hp: 95,  radius: 20, colDmg: 10 },
  spider:     { hp: 82,  radius: 17, colDmg: 8,  speedMult: 1.38 },
};

const PLAYER_DEFS = [
  { id: 'red',    color: '#e74c3c', label: 'RED'    },
  { id: 'blue',   color: '#3498db', label: 'BLUE'   },
  { id: 'green',  color: '#2ecc71', label: 'GREEN'  },
  { id: 'orange', color: '#f39c12', label: 'ORANGE' },
];
const BOT_ROLES = ['normal','tank','berserker','vampire','ghost','bomb','laser','shadow'];

// ─── FX QUEUE ─────────────────────────────────────────────────────────────────
let pendingFx = [];
function fx(obj) { pendingFx.push(obj); }

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function randVel() {
  const a = Math.random() * Math.PI * 2;
  return [Math.cos(a) * SPEED, Math.sin(a) * SPEED];
}
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx-ax, dy = by-ay, len2 = dx*dx+dy*dy;
  if (!len2) return Math.hypot(px-ax, py-ay);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/len2));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}

// ─── BALL CLASS ───────────────────────────────────────────────────────────────
class Ball {
  constructor(id, color, name, role, sx, sy) {
    this.id = id; this.color = color; this.name = name; this.role = role;
    this.startX = sx; this.startY = sy;
    const c = ROLE_CFG[role];
    this.maxHp = c.hp; this.radius = c.radius; this.colDmg = c.colDmg;
    this.inputDx = 0; this.inputDy = 0;  // player steering
    this.reset();
  }

  reset() {
    this.x = this.startX; this.y = this.startY;
    [this.vx, this.vy] = randVel();
    this.hp = this.maxHp;
    this.alive = true; this.dying = false; this.dyingTimer = 0; this.scale = 1;
    this.hitFlash = 0; this.healFlash = 0; this.colCooldown = 0;
    // status
    this.burnTimer = 0; this.burnTickTimer = 0; this.burnDmg = 4;
    this.slowTimer = 0;
    // shadow
    this.shadowCycle = 2500; this.phased = false;
    // wukong
    this.cloneTimer = 1000; this.clones = [];
    // death
    this.auraTimer = 600;
    // laser
    this.laserTimer = 3000; this.laserCharging = false; this.laserChargeDur = 0;
    this.laserActive = false; this.laserDur = 0; this.laserX = 0; this.laserY = 0; this.laserHitCD = 0;
    // bomb
    this.bombTimer = 5000; this.bombWarning = false; this.bombWarnTimer = 0;
    this.bombExploding = false; this.bombExplodeDur = 0;
    // zatan
    this.zatanSoulTimer = 2000; this.souls = [];
    this.zatanTeleTimer = 5000;
    // mummy
    this.mummyShieldTimer = 0; this.mummyShield = false; this.mummyRegenTimer = 0;
    // troll
    this.trollRegenTimer = 0;
    // dragon
    this.dragonTimer = 3000; this.dragonCharging = false; this.dragonChargeDur = 0;
    this.dragonBreathing = false; this.dragonBreathDur = 0; this.dragonBreathAngle = 0;
    // challenger
    this.challengeTarget = null; this.challengeMarkTimer = 500;
    // spider
    this.lastWebX = undefined; this.lastWebY = undefined;
  }

  takeDamage(amount) {
    if (!this.alive) return;
    if (this.role === 'shadow' && this.phased) return;
    if (this.role === 'mummy' && this.mummyShield) {
      this.mummyShield = false; this.mummyShieldTimer = 0;
      fx({ kind:'shockwave', x:this.x, y:this.y, maxR:55, color:'#ff9cf4' });
      fx({ kind:'particles', x:this.x, y:this.y, color:'#ff9cf4', count:14 });
      fx({ kind:'shake', amount:3 }); return;
    }
    this.hp = Math.max(0, this.hp - amount);
    this.hitFlash = 1.0;
    fx({ kind:'damage', x:this.x+(Math.random()-0.5)*20, y:this.y-this.radius-6, text:`-${amount}`, color:'#ff7070' });
    if (this.hp === 0) this._die();
  }

  _die() {
    this.alive = false; this.dying = true; this.dyingTimer = 350;
    fx({ kind:'particles', x:this.x, y:this.y, color:this.color, count:20 });
    fx({ kind:'shockwave', x:this.x, y:this.y, maxR:80, color:this.color });
    fx({ kind:'shake', amount:10 });
  }

  gainHp(amount) {
    if (!this.alive) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.healFlash = 1.0;
    fx({ kind:'damage', x:this.x+(Math.random()-0.5)*20, y:this.y-this.radius-6, text:`+${amount}`, color:'#55ee88' });
  }

  update(others, dt) {
    if (!this.alive) {
      if (this.dying) {
        this.dyingTimer -= dt; this.scale = Math.max(0, this.dyingTimer/350);
        if (this.dyingTimer <= 0) this.dying = false;
      }
      return;
    }
    if (this.hitFlash  > 0) this.hitFlash  = Math.max(0, this.hitFlash  - dt/220);
    if (this.healFlash > 0) this.healFlash = Math.max(0, this.healFlash - dt/300);
    if (this.colCooldown > 0) this.colCooldown -= dt;

    // BURN
    if (this.burnTimer > 0) {
      this.burnTimer -= dt; this.burnTickTimer -= dt;
      if (this.burnTickTimer <= 0) {
        this.burnTickTimer = 400;
        this.hp = Math.max(0, this.hp - this.burnDmg);
        this.hitFlash = 0.6;
        fx({ kind:'damage', x:this.x+(Math.random()-0.5)*16, y:this.y-this.radius-6, text:`-${this.burnDmg}`, color:'#ff8800' });
        fx({ kind:'particles', x:this.x+(Math.random()-0.5)*this.radius*2, y:this.y+(Math.random()-0.5)*this.radius*2, color:'#ff5500', count:2 });
        if (this.hp === 0 && this.alive) this._die();
      }
    }

    // SHADOW
    if (this.role === 'shadow') {
      this.shadowCycle = (this.shadowCycle + dt) % 6000;
      this.phased = this.shadowCycle < 1500;
    }

    // WUKONG — clone every 1s
    if (this.role === 'wukong') {
      this.cloneTimer -= dt;
      if (this.cloneTimer <= 0) {
        const a = Math.random() * Math.PI * 2;
        this.clones.push({ x:this.x, y:this.y, vx:Math.cos(a)*SPEED, vy:Math.sin(a)*SPEED, life:12000, maxLife:12000 });
        this.cloneTimer = 1000;
        fx({ kind:'particles', x:this.x, y:this.y, color:this.color, count:5 });
      }
      for (let i = this.clones.length-1; i >= 0; i--) {
        const c = this.clones[i];
        c.x += c.vx; c.y += c.vy;
        if (c.x - this.radius < 0)     { c.x = this.radius;   c.vx =  Math.abs(c.vx); }
        else if (c.x + this.radius > W) { c.x = W-this.radius; c.vx = -Math.abs(c.vx); }
        if (c.y - this.radius < 0)     { c.y = this.radius;   c.vy =  Math.abs(c.vy); }
        else if (c.y + this.radius > H) { c.y = H-this.radius; c.vy = -Math.abs(c.vy); }
        c.life -= dt;
        if (c.life <= 0) this.clones.splice(i, 1);
      }
    }

    // DEATH AURA
    if (this.role === 'death') {
      this.auraTimer -= dt;
      if (this.auraTimer <= 0) {
        for (const o of others) if (Math.hypot(o.x-this.x, o.y-this.y) < 80) o.takeDamage(3);
        this.auraTimer = 600;
      }
    }

    // LASER
    if (this.role === 'laser') {
      if (this.laserHitCD > 0) this.laserHitCD -= dt;
      if (!this.laserActive && !this.laserCharging) {
        this.laserTimer -= dt;
        if (this.laserTimer <= 0) { this.laserCharging = true; this.laserChargeDur = 650; }
      }
      if (this.laserCharging) {
        this.laserChargeDur -= dt;
        if (this.laserChargeDur <= 0) {
          this.laserCharging = false; this.laserActive = true; this.laserDur = 1800;
          this.laserX = this.x; this.laserY = this.y; this.laserTimer = 4500; this.laserHitCD = 0;
          fx({ kind:'shake', amount:4 });
        }
      }
      if (this.laserActive) {
        this.laserDur -= dt;
        if (this.laserDur <= 0) { this.laserActive = false; }
        else if (this.laserHitCD <= 0) {
          for (const o of others) {
            if (Math.abs(o.y-this.laserY) <= o.radius+3 || Math.abs(o.x-this.laserX) <= o.radius+3) {
              o.takeDamage(25); fx({ kind:'shockwave', x:o.x, y:o.y, maxR:48, color:this.color });
              fx({ kind:'shake', amount:5 }); this.laserHitCD = 700; break;
            }
          }
        }
      }
    }

    // BOMB
    if (this.role === 'bomb') {
      this.bombTimer -= dt;
      if (this.bombTimer <= 0 && !this.bombWarning) { this.bombWarning = true; this.bombWarnTimer = 600; }
      if (this.bombWarning) {
        this.bombWarnTimer -= dt;
        if (this.bombWarnTimer <= 0) {
          this.bombWarning = false; this.bombTimer = 5000;
          this.bombExploding = true; this.bombExplodeDur = 350;
          fx({ kind:'particles', x:this.x, y:this.y, color:'#ff6600', count:18 });
          fx({ kind:'shockwave', x:this.x, y:this.y, maxR:90, color:'#ff8800' });
          fx({ kind:'shake', amount:12 });
          for (const o of others) if (Math.hypot(o.x-this.x, o.y-this.y) < 80) o.takeDamage(30);
        }
      }
      if (this.bombExploding) { this.bombExplodeDur -= dt; if (this.bombExplodeDur <= 0) this.bombExploding = false; }
    }

    // ZATAN — souls
    if (this.role === 'zatan') {
      this.zatanSoulTimer -= dt;
      if (this.zatanSoulTimer <= 0) {
        for (let i=0; i<5; i++) {
          const a=(i/5)*Math.PI*2;
          this.souls.push({ x:this.x, y:this.y, vx:Math.cos(a)*2.2, vy:Math.sin(a)*2.2, life:3000 });
        }
        this.zatanSoulTimer = 5000;
        fx({ kind:'shockwave', x:this.x, y:this.y, maxR:40, color:'#9b00c4' });
      }
      for (let i=this.souls.length-1; i>=0; i--) {
        const s=this.souls[i];
        let nearDist=Infinity, nearOpp=null;
        for (const o of others) { const d=Math.hypot(o.x-s.x, o.y-s.y); if (d<nearDist){nearDist=d;nearOpp=o;} }
        if (nearOpp) {
          const dx=nearOpp.x-s.x, dy=nearOpp.y-s.y, d=Math.hypot(dx,dy)||1;
          s.vx+=(dx/d)*0.14; s.vy+=(dy/d)*0.14;
          const spd=Math.hypot(s.vx,s.vy); if(spd>3.8){s.vx=(s.vx/spd)*3.8;s.vy=(s.vy/spd)*3.8;}
        }
        s.x+=s.vx; s.y+=s.vy;
        if(s.x<0||s.x>W)s.vx*=-1; if(s.y<0||s.y>H)s.vy*=-1;
        s.life-=dt;
        let hit=false;
        for (const o of others) {
          if(Math.hypot(o.x-s.x,o.y-s.y)<o.radius+7){
            o.takeDamage(18); fx({kind:'particles',x:s.x,y:s.y,color:'#cc44ff',count:10});
            fx({kind:'shockwave',x:s.x,y:s.y,maxR:32,color:'#9b00c4'}); fx({kind:'shake',amount:3}); hit=true; break;
          }
        }
        if(hit||s.life<=0) this.souls.splice(i,1);
      }
      // ZATAN — teleport
      this.zatanTeleTimer -= dt;
      if (this.zatanTeleTimer <= 0 && others.length > 0) {
        this.zatanTeleTimer = 4000;
        const target = others[Math.floor(Math.random()*others.length)];
        fx({kind:'shockwave',x:this.x,y:this.y,maxR:52,color:'#9b00c4'});
        fx({kind:'particles',x:this.x,y:this.y,color:'#cc44ff',count:18});
        const ang=Math.random()*Math.PI*2, gap=target.radius+this.radius+8;
        this.x = Math.max(this.radius, Math.min(W-this.radius, target.x+Math.cos(ang)*gap));
        this.y = Math.max(this.radius, Math.min(H-this.radius, target.y+Math.sin(ang)*gap));
        fx({kind:'shockwave',x:this.x,y:this.y,maxR:52,color:'#cc44ff'});
        fx({kind:'particles',x:this.x,y:this.y,color:'#9b00c4',count:18});
        fx({kind:'shake',amount:3});
        const dx=this.x-target.x, dy=this.y-target.y, d=Math.hypot(dx,dy)||1;
        this.vx=(dx/d)*SPEED; this.vy=(dy/d)*SPEED;
      }
    }

    // MUMMY
    if (this.role === 'mummy') {
      this.mummyRegenTimer += dt;
      if (this.mummyRegenTimer >= 1000 && this.hp < this.maxHp) { this.gainHp(1); this.mummyRegenTimer=0; }
      else if (this.hp >= this.maxHp) this.mummyRegenTimer=0;
      if (!this.mummyShield) {
        this.mummyShieldTimer += dt;
        if (this.mummyShieldTimer >= 7000) { this.mummyShield=true; fx({kind:'particles',x:this.x,y:this.y,color:'#ff9cf4',count:10}); }
      }
    }

    // TROLL
    if (this.role === 'troll') {
      this.trollRegenTimer += dt;
      if (this.trollRegenTimer >= 800 && this.hp < this.maxHp) {
        this.gainHp(3); this.trollRegenTimer=0; fx({kind:'particles',x:this.x,y:this.y,color:'#2ecc71',count:3});
      } else if (this.hp >= this.maxHp) this.trollRegenTimer=0;
    }

    // DRAGON
    if (this.role === 'dragon') {
      if (!this.dragonBreathing && !this.dragonCharging) {
        this.dragonTimer -= dt; if (this.dragonTimer<=0){this.dragonCharging=true;this.dragonChargeDur=600;}
      }
      if (this.dragonCharging) {
        this.dragonChargeDur -= dt;
        if (this.dragonChargeDur<=0) {
          this.dragonCharging=false; this.dragonBreathing=true; this.dragonBreathDur=450;
          this.dragonBreathAngle=Math.atan2(this.vy,this.vx); this.dragonTimer=4500;
          fx({kind:'shake',amount:5});
          const a=this.dragonBreathAngle, half=Math.PI/5;
          for (const o of others) {
            const dx=o.x-this.x, dy=o.y-this.y, dist=Math.hypot(dx,dy);
            if (dist<135) {
              let ang=Math.atan2(dy,dx)-a;
              while(ang>Math.PI)ang-=Math.PI*2; while(ang<-Math.PI)ang+=Math.PI*2;
              if(Math.abs(ang)<half){o.takeDamage(20);o.burnTimer=2200;o.burnTickTimer=0;o.burnDmg=4;}
            }
          }
          for(let i=0;i<20;i++){const sp=(Math.random()-0.5)*Math.PI/2.5,fa=a+sp,d=14+Math.random()*120;fx({kind:'particles',x:this.x+Math.cos(fa)*d,y:this.y+Math.sin(fa)*d,color:'#ff6600',count:1});}
        }
      }
      if (this.dragonBreathing){this.dragonBreathDur-=dt;if(this.dragonBreathDur<=0)this.dragonBreathing=false;}
    }

    // CHALLENGER
    if (this.role === 'challenger') {
      this.challengeMarkTimer -= dt;
      if (this.challengeMarkTimer<=0) {
        this.challengeMarkTimer=1000;
        this.challengeTarget = others.length>0 ? others.reduce((b,o)=>o.hp>b.hp?o:b, others[0]) : null;
      }
      if (this.challengeTarget && this.challengeTarget.alive) {
        const dx=this.challengeTarget.x-this.x, dy=this.challengeTarget.y-this.y, d=Math.hypot(dx,dy)||1;
        this.vx+=(dx/d)*0.22; this.vy+=(dy/d)*0.22;
      }
    }

    // SPIDER — web trail
    if (this.role === 'spider') {
      if (this.lastWebX === undefined) { this.lastWebX=this.x; this.lastWebY=this.y; }
      else {
        const moved=Math.hypot(this.x-this.lastWebX, this.y-this.lastWebY);
        if (moved>=7) {
          spiderWebs.push({ x1:this.lastWebX, y1:this.lastWebY, x2:this.x, y2:this.y, life:5500, maxLife:5500, ownerId:this.id });
          this.lastWebX=this.x; this.lastWebY=this.y;
        }
      }
    }

    // BERSERKER SPARKS
    if (this.role==='berserker' && this.hp<this.maxHp*0.5 && Math.random()<0.05)
      fx({kind:'particles',x:this.x+(Math.random()-0.5)*this.radius,y:this.y+(Math.random()-0.5)*this.radius,color:'#ff4400',count:1});

    // PLAYER STEERING
    if (this.inputDx !== 0 || this.inputDy !== 0) {
      this.vx += this.inputDx * STEER;
      this.vy += this.inputDy * STEER;
    }

    // MOVE
    this.x += this.vx; this.y += this.vy;
    if (this.role==='ghost') {
      if(this.x+this.radius<0)this.x=W+this.radius;
      else if(this.x-this.radius>W)this.x=-this.radius;
      if(this.y+this.radius<0)this.y=H+this.radius;
      else if(this.y-this.radius>H)this.y=-this.radius;
    } else {
      if(this.x-this.radius<0){this.x=this.radius;this.vx=Math.abs(this.vx);fx({kind:'particles',x:this.x,y:this.y,color:this.color,count:3});}
      else if(this.x+this.radius>W){this.x=W-this.radius;this.vx=-Math.abs(this.vx);fx({kind:'particles',x:this.x,y:this.y,color:this.color,count:3});}
      if(this.y-this.radius<0){this.y=this.radius;this.vy=Math.abs(this.vy);fx({kind:'particles',x:this.x,y:this.y,color:this.color,count:3});}
      else if(this.y+this.radius>H){this.y=H-this.radius;this.vy=-Math.abs(this.vy);fx({kind:'particles',x:this.x,y:this.y,color:this.color,count:3});}
    }

    // SPEED NORMALISE
    let targetSpd = SPEED * (ROLE_CFG[this.role].speedMult || 1);
    if (this.role==='challenger' && this.challengeTarget?.alive) targetSpd *= 1.45;
    if (this.slowTimer>0){targetSpd*=0.38;this.slowTimer-=dt;}
    const spd=Math.hypot(this.vx,this.vy);
    if(spd>0){this.vx=(this.vx/spd)*targetSpd;this.vy=(this.vy/spd)*targetSpd;}
  }

  serialize() {
    return {
      id:this.id, color:this.color, name:this.name, role:this.role,
      x:Math.round(this.x*10)/10, y:Math.round(this.y*10)/10,
      hp:this.hp, maxHp:this.maxHp, alive:this.alive, dying:this.dying,
      scale:Math.round(this.scale*100)/100,
      hitFlash:Math.round(this.hitFlash*100)/100,
      healFlash:Math.round(this.healFlash*100)/100,
      phased:this.phased,
      clones:this.clones.map(c=>({x:Math.round(c.x),y:Math.round(c.y),life:c.life,maxLife:c.maxLife})),
      laserActive:this.laserActive, laserX:Math.round(this.laserX), laserY:Math.round(this.laserY),
      laserDur:this.laserDur, laserCharging:this.laserCharging, laserChargeDur:this.laserChargeDur,
      bombWarning:this.bombWarning, bombWarnTimer:this.bombWarnTimer,
      bombExploding:this.bombExploding, bombExplodeDur:this.bombExplodeDur,
      souls:this.souls.map(s=>({x:Math.round(s.x),y:Math.round(s.y),life:s.life})),
      mummyShield:this.mummyShield, mummyShieldTimer:this.mummyShieldTimer,
      dragonCharging:this.dragonCharging, dragonChargeDur:this.dragonChargeDur,
      dragonBreathing:this.dragonBreathing, dragonBreathDur:this.dragonBreathDur, dragonBreathAngle:this.dragonBreathAngle,
      challengeTargetId:this.challengeTarget?.id || null,
      burnTimer:this.burnTimer, slowTimer:this.slowTimer,
    };
  }
}

// ─── GAME STATE ───────────────────────────────────────────────────────────────
let gameState  = 'lobby';
let gameSpeed  = 1;
let balls      = [];
let spiderWebs = [];
let tickInterval = null;

// Slots — one per player colour
const slots = PLAYER_DEFS.map(p => ({
  id:p.id, color:p.color, label:p.label,
  ws:null, role:null, isBot:false, ball:null
}));

// ─── NETWORKING ───────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const s of slots) if (s.ws && s.ws.readyState === 1) s.ws.send(str);
}

function broadcastLobby() {
  broadcast({
    type: 'lobby',
    gameState,
    slots: slots.map(s => ({ id:s.id, color:s.color, label:s.label, role:s.role, connected:!!s.ws, isBot:s.isBot }))
  });
}

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function startGame() {
  gameState = 'playing';
  spiderWebs.length = 0;
  const starts = [
    [W*0.2, H*0.25], [W*0.8, H*0.25], [W*0.2, H*0.75], [W*0.8, H*0.75]
  ];
  balls = slots.map((s, i) => {
    const role = s.role || BOT_ROLES[Math.floor(Math.random()*BOT_ROLES.length)];
    if (!s.role) s.isBot = true;
    const b = new Ball(s.id, s.color, s.label, role, starts[i][0], starts[i][1]);
    s.ball = b;
    return b;
  });
  broadcast({ type:'start', gameState:'playing' });
  broadcastLobby();
}

function resetGame() {
  gameState = 'lobby';
  spiderWebs.length = 0;
  balls = [];
  slots.forEach(s => { s.ball=null; s.isBot=false; if (!s.ws) s.role=null; });
  broadcastLobby();
}

function resolveCollision(a, b) {
  const dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy)||1;
  const overlap=(a.radius+b.radius)-dist;
  if(overlap>0){const nx=dx/dist,ny=dy/dist;a.x-=nx*overlap/2;a.y-=ny*overlap/2;b.x+=nx*overlap/2;b.y+=ny*overlap/2;}
  const nx=dx/dist,ny=dy/dist,dot=(a.vx-b.vx)*nx+(a.vy-b.vy)*ny;
  if(dot<=0)return;
  a.vx-=dot*nx;a.vy-=dot*ny;b.vx+=dot*nx;b.vy+=dot*ny;
}

// ─── GAME LOOP ────────────────────────────────────────────────────────────────
tickInterval = setInterval(() => {
  if (gameState !== 'playing' || !balls.length) return;

  const dt = TICK * gameSpeed;
  const aliveBalls = balls.filter(b => b.alive);
  const aliveSet   = new Set(aliveBalls);

  // Update
  for (const b of balls) b.update(aliveBalls.filter(o=>o!==b), dt);

  // Challenger kill reward
  for (const b of balls) {
    if (aliveSet.has(b) && !b.alive) {
      for (const ch of balls) {
        if (ch.role==='challenger' && ch.alive && ch.challengeTarget===b) {
          ch.gainHp(50);
          fx({kind:'shockwave',x:ch.x,y:ch.y,maxR:70,color:ch.color});
          fx({kind:'particles',x:ch.x,y:ch.y,color:ch.color,count:18});
          fx({kind:'shake',amount:5});
        }
      }
    }
  }

  // Spider webs
  for (let wi=spiderWebs.length-1; wi>=0; wi--) {
    const w=spiderWebs[wi]; w.life-=dt;
    if(w.life<=0){spiderWebs.splice(wi,1);continue;}
    let hit=false;
    for (const b of aliveBalls) {
      if(b.id===w.ownerId)continue;
      if(pointSegDist(b.x,b.y,w.x1,w.y1,w.x2,w.y2)<b.radius+5){
        b.slowTimer=Math.max(b.slowTimer,2500);
        fx({kind:'particles',x:(w.x1+w.x2)/2,y:(w.y1+w.y2)/2,color:'#c0ddff',count:7});
        hit=true;
      }
    }
    if(hit)spiderWebs.splice(wi,1);
  }

  // All-pairs collision
  const alive2 = balls.filter(b=>b.alive);
  for (let i=0;i<alive2.length;i++) {
    for (let j=i+1;j<alive2.length;j++) {
      const a=alive2[i],b=alive2[j];
      if(Math.hypot(b.x-a.x,b.y-a.y)<a.radius+b.radius){
        resolveCollision(a,b);
        if(a.colCooldown<=0&&b.colCooldown<=0){
          const dAB=a.role==='berserker'?10+Math.floor((1-a.hp/a.maxHp)*20):a.colDmg;
          const dBA=b.role==='berserker'?10+Math.floor((1-b.hp/b.maxHp)*20):b.colDmg;
          a.takeDamage(dBA);b.takeDamage(dAB);
          if(a.role==='vampire'&&a.alive)a.gainHp(8);
          if(b.role==='vampire'&&b.alive)b.gainHp(8);
          a.colCooldown=600;b.colCooldown=600;
          const mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
          fx({kind:'particles',x:mx,y:my,color:'#fff',count:10});
          const big=a.role==='tank'||b.role==='tank'||a.role==='troll'||b.role==='troll';
          fx({kind:'shockwave',x:mx,y:my,maxR:big?72:50,color:'#fff'});
          fx({kind:'shake',amount:big?8:3});
        }
      }
    }
  }

  // Wukong clone hits
  for (const wu of balls) {
    if(wu.role!=='wukong')continue;
    for (const opp of alive2.filter(b=>b!==wu)) {
      for (let i=wu.clones.length-1;i>=0;i--) {
        const c=wu.clones[i];
        if(Math.hypot(opp.x-c.x,opp.y-c.y)<opp.radius+wu.radius*0.88){
          opp.takeDamage(8);
          fx({kind:'particles',x:c.x,y:c.y,color:wu.color,count:8});
          fx({kind:'shockwave',x:c.x,y:c.y,maxR:30,color:wu.color});
          wu.clones.splice(i,1); break;
        }
      }
    }
  }

  // Broadcast state
  const stateMsg = JSON.stringify({
    type: 'state',
    balls: balls.map(b=>b.serialize()),
    webs:  spiderWebs.map(w=>({x1:Math.round(w.x1),y1:Math.round(w.y1),x2:Math.round(w.x2),y2:Math.round(w.y2),life:w.life,maxLife:w.maxLife,ownerId:w.ownerId})),
  });
  for (const s of slots) if(s.ws&&s.ws.readyState===1) s.ws.send(stateMsg);

  // Broadcast pending FX
  if (pendingFx.length) {
    const fxMsg = JSON.stringify({ type:'fx', events:pendingFx });
    for (const s of slots) if(s.ws&&s.ws.readyState===1) s.ws.send(fxMsg);
    pendingFx = [];
  }

  // Game over check
  const stillAlive = balls.filter(b=>b.alive);
  if (stillAlive.length <= 1) {
    gameState = 'gameover';
    const winner = stillAlive[0] || null;
    setTimeout(() => {
      broadcast({ type:'gameover', winnerId:winner?.id||null, winnerName:winner?.name||null, winnerColor:winner?.color||null });
    }, 400);
  }
}, TICK);

// ─── WEBSOCKET SERVER ─────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const file = req.url === '/' || req.url === '/index.html' ? 'index.html' : null;
  if (file) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  // Assign slot
  const slot = slots.find(s => !s.ws && !s.isBot);
  if (!slot) { ws.close(1008, 'Game full'); return; }
  slot.ws = ws;
  console.log(`[+] ${slot.label} connected`);

  send(ws, { type:'welcome', slotId:slot.id, gameState, W, H });
  broadcastLobby();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'selectRole' && gameState === 'lobby') {
      slot.role = msg.role; broadcastLobby();

    } else if (msg.type === 'startGame' && gameState === 'lobby') {
      startGame();

    } else if (msg.type === 'input' && gameState === 'playing') {
      if (slot.ball && slot.ball.alive) {
        slot.ball.inputDx = Math.max(-1, Math.min(1, msg.dx || 0));
        slot.ball.inputDy = Math.max(-1, Math.min(1, msg.dy || 0));
      }

    } else if (msg.type === 'setSpeed') {
      gameSpeed = [0.5,1,2,3].includes(msg.speed) ? msg.speed : 1;
      broadcast({ type:'speedChanged', speed:gameSpeed });

    } else if (msg.type === 'playAgain') {
      if (gameState === 'gameover') { resetGame(); }

    } else if (msg.type === 'backToLobby') {
      if (gameState === 'gameover') { resetGame(); }
    }
  });

  ws.on('close', () => {
    console.log(`[-] ${slot.label} disconnected`);
    slot.ws = null;
    if (gameState === 'lobby') slot.role = null;
    else if (slot.ball) { /* ball continues as bot */ }
    broadcastLobby();
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`\nBall Battle server running!`);
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://${localIP}:${PORT}  ← share this with players\n`);
});
