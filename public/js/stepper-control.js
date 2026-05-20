(function () {
  'use strict';

  /* ── StepperControl: increment/decrement with typeable number ── */
  class StepperControl {
    constructor(el, opts) {
      this.el = typeof el === 'string' ? document.querySelector(el) : el;
      if (!this.el) return;
      this.input = this.el.querySelector('.stepper-input') || this.el.querySelector('input');
      if (!this.input) return;
      this.min = opts && opts.min != null ? opts.min : parseFloat(this.input.getAttribute('min')) || 1;
      this.max = opts && opts.max != null ? opts.max : parseFloat(this.input.getAttribute('max')) || 100;
      this.step = opts && opts.step != null ? opts.step : parseFloat(this.input.getAttribute('step')) || 1;
      this.onChange = (opts && opts.onChange) || null;
      this._build();
      this._bind();
      this._updateBtns();
    }

    _build() {
      this.decBtn = document.createElement('button');
      this.decBtn.type = 'button';
      this.decBtn.className = 'stepper-btn stepper-btn--dec';
      this.decBtn.textContent = '\u2212';
      this.incBtn = document.createElement('button');
      this.incBtn.type = 'button';
      this.incBtn.className = 'stepper-btn stepper-btn--inc';
      this.incBtn.textContent = '+';
      this.input.classList.add('stepper-input');
      this.el.insertBefore(this.decBtn, this.input);
      this.el.appendChild(this.incBtn);
    }

    _bind() {
      this.decBtn.addEventListener('click', function (e) { e.preventDefault(); this._step(-1); }.bind(this));
      this.incBtn.addEventListener('click', function (e) { e.preventDefault(); this._step(1); }.bind(this));
      this.input.addEventListener('focus', function () { this._was = this.input.value; }.bind(this));
      this.input.addEventListener('blur', function () { this._clamp(); this._updateBtns(); if (this.onChange && this.input.value !== this._was) this.onChange(this.value); }.bind(this));
      this.input.addEventListener('input', function () { this._updateBtns(); }.bind(this));
      this.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { this.input.blur(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this._step(1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); this._step(-1); }
      }.bind(this));
    }

    _step(dir) {
      var val = parseFloat(this.input.value);
      if (isNaN(val)) val = this.min;
      val = Math.round((val + dir * this.step) / this.step) * this.step;
      val = Math.max(this.min, Math.min(this.max, val));
      this.input.value = val;
      this._updateBtns();
      if (this.onChange) this.onChange(val);
    }

    _clamp() {
      var val = parseFloat(this.input.value);
      if (isNaN(val)) val = this.min;
      this.input.value = Math.max(this.min, Math.min(this.max, val));
    }

    _updateBtns() {
      var val = parseFloat(this.input.value);
      if (isNaN(val)) { this.decBtn.disabled = false; this.incBtn.disabled = false; return; }
      this.decBtn.disabled = val <= this.min;
      this.incBtn.disabled = val >= this.max;
    }

    get value() { return parseFloat(this.input.value); }
    set value(v) { this.input.value = Math.max(this.min, Math.min(this.max, v)); this._updateBtns(); }
  }

  /* ── SegmentedToggle: select one option from a set ── */
  class SegmentedToggle {
    constructor(el, opts) {
      this.el = typeof el === 'string' ? document.querySelector(el) : el;
      if (!this.el) return;
      this.hiddenInput = opts && opts.input ? (typeof opts.input === 'string' ? document.querySelector(opts.input) : opts.input) : this.el.querySelector('input[type="hidden"]');
      this.onChange = (opts && opts.onChange) || null;
      this._bind();
    }

    _bind() {
      var self = this;
      var options = this.el.querySelectorAll('.segmented-option');
      options.forEach(function (opt) {
        opt.addEventListener('click', function (e) {
          e.preventDefault();
          options.forEach(function (o) { o.classList.remove('active'); });
          opt.classList.add('active');
          var val = opt.getAttribute('data-value') || opt.textContent.trim();
          if (self.hiddenInput) self.hiddenInput.value = val;
          if (self.onChange) self.onChange(val);
        });
      });
    }

    get value() {
      var active = this.el.querySelector('.segmented-option.active');
      return active ? (active.getAttribute('data-value') || active.textContent.trim()) : null;
    }

    set value(v) {
      var self = this;
      var options = this.el.querySelectorAll('.segmented-option');
      options.forEach(function (opt) {
        var matches = (opt.getAttribute('data-value') || opt.textContent.trim()) === v;
        opt.classList.toggle('active', matches);
      });
      if (this.hiddenInput) this.hiddenInput.value = v;
    }
  }

  /* ── Auto-initialize on DOMContentLoaded ── */
  function init() {
    document.querySelectorAll('.stepper').forEach(function (el) {
      if (el._stepperInit) return;
      el._stepperInit = true;
      new StepperControl(el);
    });
    document.querySelectorAll('.segmented').forEach(function (el) {
      if (el._segInit) return;
      el._segInit = true;
      new SegmentedToggle(el);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.StepperControl = StepperControl;
  window.SegmentedToggle = SegmentedToggle;
})();
