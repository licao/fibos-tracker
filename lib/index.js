"use strict";

const App = require('fib-app');
const coroutine = require("coroutine");
const util = require("util");
const fs = require("fs");
const Config = require("./conf/conf.json");

let caches = new util.LruCache(1000);

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
	console.notice(`==========fibos-tracker==========\n\nDBconnString: ${Config.DBconnString.replace(/:[^:]*@/, ":*****@")}\n\n==========fibos-tracker==========`);

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

	let collectMessage = (_at) => {
		function _c(f) {
			if (hookEvents[f]) {
				messages[f] = messages[f] || [];
				messages[f].push(_at);
			}
		}

		_c(_at.act.account);

		_c(_at.act.account + "/" + _at.act.name);
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
					let t_info = db.models["transactions"].findSync({
						producer_block_id: trx.producer_block_id,
						trx_id: trx.id
					});
					if (t_info.length > 0) {
						console.warn("Reentrant trx id:", trx.id, trx.producer_block_id);
						return;
					}
					let createSync = (model, d) => {
						if (!Config.isSyncSystemBlock) return {};

						return db.models[model].createSync(d);
					}
					db.models["transactions"].createSync({
						trx_id: trx.id,
						producer_block_id: trx.producer_block_id,
						rawData: trx
					});

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
					db.trans(() => {
						if (db.models.blocks.get(bk.id)) {
							console.warn("Reentrant block id:", bk.id);
							return;
						}
						db.models["blocks"].createSync({
							block_num: bk.block_num,
							block_time: bk.block.timestamp,
							producer: bk.block.producer,
							producer_block_id: bk.id,
							previous: bk.block.previous, //前一块
							status: "reversible"
						});

						let now_block = {
							producer_block_id: bk.id,
							previous: bk.block.previous, //前一块
							next: "", //下一块
							block_num: bk.block_num,
							producer: bk.block.producer,
							status: "reversible"
						};

						caches.set(bk.id, now_block);

						let arr = [];
						try {
							while (arr.length < 14) {
								if (!now_block) break;
								arr.push(now_block);

								now_block = caches.get(now_block.previous, (k) => db.models["blocks"].oneSync({
									producer_block_id: k
								}));

							}
						} catch (e) {
							// console.error('now_block', e)
						}
						// console.error('==>', arr.length)
						if (arr.length < 13) {
							return;
						}
						if (arr.length == 14) {
							if (arr[13].status != "lightconfirm") throw new Error("13 status != lightconfirm" + arr[13].status);
							if (arr[13].producer != arr[12].producer) {
								if (arr[12].status == "lightconfirm") throw new Error("13 status != lightconfirm" + arr[12].status);
							} else {
								if (arr[12].status == "lightconfirm") return;
							}
						}
						// console.error('==>', arr)
						const producer = arr[12].producer;
						for (let i = 12; i > 0; i--) {
							if (arr[i].producer == producer) {
								arr[i].status = "lightconfirm";
								let blocks = db.models["blocks"].oneSync({
									producer_block_id: arr[i].producer_block_id
								})
								blocks.saveSync({
									status: "lightconfirm"
								});

								let createSync = (model, d) => {
									return db.models[model].createSync(d);
								}

								let trxs = db.models.transactions.findSync({
									producer_block_id: arr[i].producer_block_id
								});

								trxs.forEach((trx) => {
									let transaction_id = trx.id;
									trx = trx.rawData;

									function execActions(at, parent) {
										let parent_id;

										if (parent) {
											let _parent = deepCopy(parent);
											delete _parent.inline_traces;
											at.parent = _parent;
										}

										// parent_id = createSync('actions', {
										// 	transaction_id: !parent ? transaction_id : undefined,
										// 	parent_id: parent ? parent.parent_id : undefined,
										// 	contract_name: at.act.account,
										// 	action_name: at.act.name,
										// 	authorization: at.act.authorization.map((a) => {
										// 		return a.actor + "@" + a.permission
										// 	}),
										// 	data: (typeof at.act.data === "object") ? at.act.data : {
										// 		data: at.act.data
										// 	}
										// }).id;

										collectMessage(at);

										// at.parent_id = parent_id;

										at.inline_traces.forEach((_at) => {
											execActions(_at, at);
										});
									}

									trx.action_traces.forEach((msg) => {
										execActions(msg);
									});
								});

							}
						}
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
				if (!bk.block.transactions.length) return;

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