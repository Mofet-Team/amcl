 CL V25.1   HEATER                                     14/10/26 09:12   Page    1
  Line   Loc  Source

     1            SEQUENCE HEATER (HPM; POINT HEATER)                                               
     2            EXTERNAL TIC1                                                                     
     3            LOCAL SPARE: LOGICAL AT FL(1)                                                     
                        ^
  **WARNING **  Defined But Not Referenced
 
     4            LOCAL TEMP AT NN(1)                                                               
     5            PHASE RUN                                                                         
                  ^
  **NOTE    **  All enabled abnormal handlers are disabled
 
     6    12      SET TEMP = TIC1.PV                                                                
     7    20      END HEATER                                                                        
 
 *******  No errors detected
 
 The following source file(s) were referenced:
 
         $MEMORY>CL>HEATER.CL   (Main Source File)
