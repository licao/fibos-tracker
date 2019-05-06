"use strict";

const App = require('fib-app');
const coroutine = require("coroutine");
const util = require("util");
const fs = require("fs");
const Config = require("./conf/conf.json");

let deepCopy = (d) => {
	let r = {};

	let _deepCopy = (o, c) => {
		c = c || {}

		for (let i in o) {

			let v = o[i];
			let ty = typeof v;

			if (ty === 'object' && v !== null) {

				c[i] = (v.constructor === Array) ? [] : {};

				_deepCopy(v, c[i]);

			} else {
				c[i] = ty === "bigint" ? v.toString() : v;
			}
		}
		return c;
	}

	_deepCopy(d, r);

	return r;
}

function Tracker() {
	console.notice(`==========fibos-tracker==========\n\nDBconnString: ${Config.DBconnString.replace(/:[^:]*@/, ":*****@")}\n\nisFilterNullBlock: ${Config.isFilterNullBlock}\n\nisSyncSystemBlock:${Config.isSyncSystemBlock}\n\n==========fibos-tracker==========`);

	let timer;
	let fibos;
	let hookEvents = {};
	let sys_bn;
	let app = new App(Config.DBconnString);

	app.db.use(require('./defs'));

	let checkBlockNum = (block_num) => {

		block_num = Number(block_num);

		if (sys_bn >= block_num) {
			console.warn(util.format("sys block_num(%s) >= node block_num(%s)", sys_bn, block_num));
			return false;
		}

		return true;
	}

	this.app = app;

	this.use = (model) => {
		if (!model) throw new Error("use:function(model)");

		if (!model.defines || !model.hooks) throw new Error("model define error: Array(defines) JSON(hooks)");

		let defines = model.defines;
		let hooks = model.hooks;

		app.db.use(util.isArray(defines) ? defines : [defines]);

		for (let f in hooks) {
			hookEvents[f] = hookEvents[f] || [];
			hookEvents[f].push(hooks[f]);
		}
	};

	this.emitter = (fb) => {
		if (!fb) throw new Error("emitter params: fibos!");


		sys_bn = app.db(db => {
			return db.models.blocks.get_sys_last();
		});

		fibos = fb;

		fibos.load("emitter");

		fibos.on({
			transaction: (trx) => {
				let block_num = trx.block_num.toString();
				let producer_block_id = trx.producer_block_id;

				if (!producer_block_id) return;

				if (!checkBlockNum(block_num)) return;

				if (!trx.action_traces) {
					console.warn("Invalid Transaction:", trx);
					return;
				}
				trx = deepCopy(trx);
				if (!trx.action_traces.length) return;

				if (trx.action_traces[0].act.name === "onblock" && trx.action_traces[0].act.account === "eosio") return;

				app.db(db => {
					// if (db.models.blocks.get(bk.id)) {
					// 	console.warn("Reentrant block id:", bk.id);
					// 	return;
					// }
					let createSync = (model, d) => {
						if (!Config.isSyncSystemBlock) return {};

						return db.models[model].createSync(d);
					}
					db.models["transactions"].createSync({
						trx_id: trx.id,
						producer_block_id: trx.producer_block_id,
						rawData: trx
					})

				});
			},
			block: (bk) => {
				let block_num = bk.block_num.toString();

				if (!checkBlockNum(block_num)) return;

				if (!bk.block) {
					console.warn("Invalid Block!");
					return;
				}
				bk = deepCopy(bk);
				app.db(db => {
					if (db.models.blocks.get(bk.id)) {
						console.warn("Reentrant block id:", bk.id);
						return;
					}
					db.models["blocks"].createSync({
						block_num: bk.block_num,
						block_time: bk.block.timestamp,
						producer: bk.block.producer,
						producer_block_id: bk.id,
						status: "reversible"
					});
				});
			},
			irreversible_block: (bk) => {
				let block_num = bk.block_num.toString();

				if (!checkBlockNum(block_num)) return;

				if (!bk.block) {
					console.warn("Invalid Block!");
					return;
				}

				if (!bk.block.transactions.length && Config.isFilterNullBlock) return;

				if (!bk.validated) return;
			}
		});

	}

	this.diagram = () => fs.writeTextFile(process.cwd() + '/diagram.svg', app.diagram());

	this.stop = () => {
		let retry = 0;

		if (fibos) fibos.stop();
		process.exit();
	}
}

Tracker.Config = Config;

module.exports = Tracker;