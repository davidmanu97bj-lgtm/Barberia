const noop=()=>{};
const asyncNoop=async()=>null;
const state=Object.freeze({disabled:true,loaded:false,loading:false,rows:[],derivations:[],history:[]});
window.ExploraPerformanceEngine=Object.freeze({disabled:true,GOALS:[],refresh:asyncNoop,open:noop,close:noop,getState:()=>state,calculateGoalFromBilling:()=>null,acceptWeeklyPerformanceSnapshot:noop,isEligibleRankingParticipant:()=>false,getGoalBubbleWindow:()=>[],getVisibleGoalBubbles:()=>[],renderProfileGoal:noop,animateDashboardGoal:noop,getSettlementIncentive:()=>null,prepareSettlementIncentive:asyncNoop,recordCompletedDerivation:asyncNoop,calculateForPeriod:async()=>({rows:[],derivations:[]}),resetOperationalState:noop,applyUnifiedWeeklySnapshot:noop,applyRealtimeOperationalRows:noop,openGoalBenefitDetail:noop,closeGoalBenefitDetail:noop,invalidateRankingCache:noop,showDiagnostic:noop,closeDiagnostic:noop});
window.ExploraDerivationMoneyRankingEngine=Object.freeze({disabled:true,refresh:asyncNoop,getState:()=>state,calculateForPeriod:async()=>({rows:[],derivations:[]}),getSettlementIncentive:()=>null,DERIVATION_PERCENT:0});
window.ExploraUIRankingGoalsDerivationsRepair=Object.freeze({disabled:true,audit:noop});
console.info("EXPLORA_LEGACY_PERFORMANCE_RANKING_DISABLED");
export {};
