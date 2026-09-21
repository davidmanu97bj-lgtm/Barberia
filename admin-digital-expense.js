export function buildAdminDigitalExpense({driver,actor,amount,detail,typeId,proofUrl,proofPath,file,operation,fingerprint,businessId,dayKey},expensePolicy,periodPolicy){
  const type=expensePolicy.find(typeId);
  if(!driver?.id||!actor?.uid||!type||!Number.isFinite(amount)||amount<=0||amount>100000000||!String(detail).trim()||!proofUrl||!proofPath)throw new Error('Revisá el chofer, el concepto, el importe y el comprobante.');
  const name=driver.name,rate=type.refundRate;
  return {amount,monto:amount,detail,notes:detail,expenseType:type.id,tipo:type.id,category:type.id,expenseLabel:type.label,
    expenseResponsibility:type.group,reimbursementRate:rate,driverExpenseRate:1-rate,sharedRate:1-rate,porcentajeCompartido:(1-rate)*100,
    expensePaymentMethod:'digital',payerRole:'explora',receiptFlowVersion:expensePolicy.version,settlementRuleVersion:periodPolicy.VERSION,
    billingImpactAmount:amount*periodPolicy.expenseRate({expensePaymentMethod:'digital'},type),autoApplyToBilling:true,billingImpactMode:'expense_policy',
    driverDebtAmount:type.group==='driver'?amount:0,telegramExpenseLoadedAmount:amount,telegramExpenseRecognizedAmount:amount*rate,
    proofUrl,proofPath,receiptUrl:proofUrl,receiptPath:proofPath,proofMimeType:file.type,proofFileName:file.name,
    driverUid:driver.id,choferUid:driver.id,uid:driver.id,ownerUid:driver.id,driverId:driver.id,operatorUid:driver.id,driverName:name,operatorName:name,
    createdByUid:actor.uid,createdByName:actor.name,createdByRole:'admin',registeredByAdmin:true,status:'active',businessId,dayKey,
    idempotencyKey:operation.operationId,clientOperationId:operation.operationId,submissionFingerprint:fingerprint,idempotencyVersion:1,createdAtMs:operation.createdAtMs};
}
