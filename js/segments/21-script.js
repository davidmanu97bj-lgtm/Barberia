
(()=>{
  "use strict";
  document.addEventListener("input",event=>{
    if(event.target?.id==="adminLoanAmount")event.target.value=window.formatCurrencyInput?.(event.target.value)||event.target.value;
  });
})();
