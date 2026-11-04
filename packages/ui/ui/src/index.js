"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.__PLACEHOLDER__ = void 0;
exports.KPICard = KPICard;
exports.BigNumber = BigNumber;
exports.StatusPill = StatusPill;
exports.EmptyState = EmptyState;
exports.ListPagination = ListPagination;
exports.BeijingClock = BeijingClock;
// 🟡 占位骨架 (agent-e 2026-07-29) — 真实实现待 V2 重构时填入
// 每个组件用最小"返回 children 的容器"实现，保证 React 树型不报错
// 详见 ut skill `ut_dev-patterns/lions-monorepo-setup` §15.4 占位 SOP
var react_1 = require("react");
function KPICard(props) {
    return react_1.default.createElement("div", __assign({}, props));
}
function BigNumber(props) {
    return react_1.default.createElement("div", __assign({}, props));
}
function StatusPill(props) {
    return react_1.default.createElement("span", __assign({}, props));
}
function EmptyState(props) {
    return react_1.default.createElement("div", __assign({}, props));
}
function ListPagination(props) {
    return react_1.default.createElement("div", __assign({}, props));
}
function BeijingClock(props) {
    return react_1.default.createElement("div", __assign({}, props));
}
exports.__PLACEHOLDER__ = true;
